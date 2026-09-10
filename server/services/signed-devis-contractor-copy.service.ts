import { createHash } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  projectCommunications,
  signedDevisCopyNotices,
  type InsertProjectCommunication,
  type Devis,
  type SignedDevisCopyNotice,
} from "@shared/schema";
import { isValidRecipientEmail } from "../communications/email-sender";
import { MAX_SIGNED_PDF_RETRY_ATTEMPTS } from "./signed-pdf-retry-policy";

export const SIGNED_COPY_SETTING_KEY = "automatic_signed_devis_contractor_copies";
export const MAX_SIGNED_COPY_SEND_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

export interface SignedCopySetting {
  enabled: boolean;
  activatedAt: string | null;
}

export function signedCopyDeliveryReference(notice: Pick<SignedDevisCopyNotice, "id" | "archisignEnvelopeId">): string {
  const digest = createHash("sha256")
    .update(`${notice.id}:${notice.archisignEnvelopeId}`)
    .digest("hex")
    .slice(0, 20);
  return `AT-DV-${digest}`;
}

export async function getSignedCopySetting(): Promise<SignedCopySetting> {
  const raw = await storage.getAppSetting(SIGNED_COPY_SETTING_KEY);
  if (!raw) return { enabled: false, activatedAt: null };
  try {
    const value = JSON.parse(raw) as Partial<SignedCopySetting>;
    const activatedAt = typeof value.activatedAt === "string" ? value.activatedAt : null;
    if (
      value.enabled === true
      && (!activatedAt || Number.isNaN(new Date(activatedAt).getTime()))
    ) {
      return { enabled: false, activatedAt: null };
    }
    return {
      enabled: value.enabled === true,
      activatedAt,
    };
  } catch {
    // A malformed operator setting is fail-closed.
    return { enabled: false, activatedAt: null };
  }
}

export async function setSignedCopyEnabled(enabled: boolean): Promise<SignedCopySetting> {
  const current = await getSignedCopySetting();
  const next: SignedCopySetting = enabled
    ? {
        enabled: true,
        // Every disabled -> enabled transition creates a new forward-only
        // boundary. An idempotent PUT true preserves the existing boundary.
        activatedAt: current.enabled && current.activatedAt
          ? current.activatedAt
          : new Date().toISOString(),
      }
    : { enabled: false, activatedAt: current.activatedAt };
  await storage.setAppSetting(SIGNED_COPY_SETTING_KEY, JSON.stringify(next));
  return next;
}

/** Called synchronously by the signed webhook after envelope lookup. */
export async function recordEligibleSignedCopyIntent(
  d: Devis,
  envelopeId: string,
  signedAt: Date,
): Promise<SignedDevisCopyNotice | null> {
  const setting = await getSignedCopySetting();
  if (!setting.enabled || !setting.activatedAt) return null;
  const boundary = new Date(setting.activatedAt);
  if (
    Number.isNaN(boundary.getTime())
    || Number.isNaN(signedAt.getTime())
    || signedAt < boundary
  ) return null;

  const [inserted] = await db
    .insert(signedDevisCopyNotices)
    .values({
      devisId: d.id,
      projectId: d.projectId,
      archisignEnvelopeId: envelopeId,
      intendedContractorId: d.contractorId,
      signedAt,
      status: "pending_pdf",
      nextAttemptAt: new Date(),
    })
    .onConflictDoNothing({
      target: [signedDevisCopyNotices.devisId, signedDevisCopyNotices.archisignEnvelopeId],
    })
    .returning();
  if (inserted) return inserted;
  const [existing] = await db.select().from(signedDevisCopyNotices).where(and(
    eq(signedDevisCopyNotices.devisId, d.id),
    eq(signedDevisCopyNotices.archisignEnvelopeId, envelopeId),
  )).limit(1);
  return existing ?? null;
}

export async function getSignedCopyNoticeForDevis(devisId: number): Promise<SignedDevisCopyNotice | null> {
  const [row] = await db.select().from(signedDevisCopyNotices)
    .where(eq(signedDevisCopyNotices.devisId, devisId))
    .orderBy(sql`${signedDevisCopyNotices.id} DESC`)
    .limit(1);
  return row ?? null;
}

function subject(ref: string, projectName: string): string {
  return `Copie du devis signé ${ref} — ${projectName}`;
}

function body(contractorName: string, ref: string, projectName: string, deliveryRef: string): string {
  return (
    `Bonjour ${contractorName},\n\n` +
    `Veuillez trouver en pièce jointe une copie du devis ${ref}, signé par le client pour le projet « ${projectName} ».\n\n` +
    `Cet envoi vous transmet uniquement la copie signée. Il ne constitue ni une demande de paiement, ni une nouvelle instruction de démarrage des travaux.\n\n` +
    `Référence de remise : ${deliveryRef}\n\n` +
    `Cordialement,\nSAS Architects-France\n`
  );
}

function hasHeaderBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

function sameAttachments(value: unknown, expectedKey: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expectedKey;
}

/**
 * Recovery-safe bridge between persisted Archisign bytes and the mail outbox.
 * May be called after storage, by a sweeper, or repeatedly.
 */
export async function materializeSignedCopyOutbox(devisId: number): Promise<SignedDevisCopyNotice | null> {
  const notice = await getSignedCopyNoticeForDevis(devisId);
  return notice ? materializeSignedCopyNotice(notice.id) : null;
}

/** Exact-notice variant used by the sweeper so old envelopes cannot alias the latest row. */
export async function materializeSignedCopyNotice(noticeId: number): Promise<SignedDevisCopyNotice | null> {
  const [notice] = await db.select().from(signedDevisCopyNotices)
    .where(eq(signedDevisCopyNotices.id, noticeId)).limit(1);
  if (!notice || notice.communicationId || notice.status === "sent") return notice;
  const devisId = notice.devisId;
  const d = await storage.getDevis(devisId);
  const project = d ? await storage.getProject(d.projectId) : undefined;
  const contractor = notice.intendedContractorId
    ? await storage.getContractor(notice.intendedContractorId)
    : undefined;

  let failure: string | null = null;
  if (!d || !project) failure = "Devis or project no longer exists";
  else if (d.projectId !== notice.projectId)
    failure = "Project no longer matches the signed-copy intent";
  else if (d.signOffStage !== "client_signed_off" || d.signedOffVia !== "archisign")
    failure = "Devis is not a verified Archisign completion";
  else if (d.archisignEnvelopeId !== notice.archisignEnvelopeId)
    failure = "Archisign envelope no longer matches the signed-copy intent";
  else if (d.contractorId !== notice.intendedContractorId)
    failure = "Contractor assignment changed after signature; automatic delivery is blocked";
  else if (!d.signedPdfStorageKey || d.signedPdfArchisignEnvelopeId !== notice.archisignEnvelopeId) {
    if (
      (d.signedPdfRetryAttempts ?? 0) >= MAX_SIGNED_PDF_RETRY_ATTEMPTS
      && !d.signedPdfNextAttemptAt
      && d.signedPdfLastError
    ) {
      const [failed] = await db.update(signedDevisCopyNotices).set({
        status: "failed",
        lastError: `Verified Archisign signed PDF could not be stored: ${d.signedPdfLastError}`,
        nextAttemptAt: new Date("9999-12-31T23:59:59.000Z"),
        updatedAt: new Date(),
      }).where(and(
        eq(signedDevisCopyNotices.id, notice.id),
        sql`${signedDevisCopyNotices.communicationId} IS NULL`,
      )).returning();
      return failed ?? notice;
    } else {
      // Do not let an unavailable early row monopolise every sweep batch.
      await db.update(signedDevisCopyNotices).set({
        nextAttemptAt: d.signedPdfNextAttemptAt ?? new Date(Date.now() + 60_000),
        lastError: d.signedPdfLastError ?? "Waiting for verified Archisign signed PDF storage",
        updatedAt: new Date(),
      }).where(eq(signedDevisCopyNotices.id, notice.id));
      return getSignedCopyNoticeForDevis(devisId);
    }
  }
  else if (project.archivedAt)
    failure = "Project is archived; automatic signed-copy delivery is blocked";
  else if (!contractor)
    failure = "Intended contractor no longer exists";

  const recipientEmail = (contractor?.email ?? "").trim();
  if (!failure && !isValidRecipientEmail(recipientEmail))
    failure = "Contractor email is missing or invalid";

  const ref = d?.devisNumber || d?.devisCode || `DV-${devisId}`;
  const projectName = project?.name ?? `Projet ${notice.projectId}`;
  if (!failure && (hasHeaderBreak(ref) || hasHeaderBreak(projectName))) {
    failure = "Devis reference or project name contains an invalid email-header line break";
  }
  const expectedSubject = subject(ref, projectName);
  const expectedBody = body(
    contractor?.name ?? "Madame, Monsieur",
    ref,
    projectName,
    signedCopyDeliveryReference(notice),
  );
  const expectedAttachment = (
    d?.signedPdfStorageKey
    && d.signedPdfArchisignEnvelopeId === notice.archisignEnvelopeId
  ) ? d.signedPdfStorageKey : null;
  const communication = {
    projectId: notice.projectId,
    type: "devis_signed_contractor_copy",
    recipientType: "contractor",
    recipientEmail,
    recipientName: contractor?.name ?? null,
    subject: expectedSubject,
    body: expectedBody,
    attachmentStorageKeys: expectedAttachment ? [expectedAttachment] : [],
    status: failure ? "failed" : "queued",
    relatedDevisId: devisId,
    dedupeKey: `devis_signed_contractor_copy:${devisId}:${notice.archisignEnvelopeId}`,
  } as InsertProjectCommunication & { relatedDevisId: number };
  const created = await storage.createProjectCommunication(communication);
  const immutableTupleMatches =
    created.projectId === notice.projectId
    && created.type === communication.type
    && created.recipientType === communication.recipientType
    && created.recipientEmail === communication.recipientEmail
    && created.recipientName === communication.recipientName
    && created.subject === expectedSubject
    && created.body === expectedBody
    && created.relatedDevisId === devisId
    && created.dedupeKey === communication.dedupeKey
    && (
      expectedAttachment
        ? sameAttachments(created.attachmentStorageKeys, expectedAttachment)
        : Array.isArray(created.attachmentStorageKeys)
          && created.attachmentStorageKeys.length === 0
    );
  if (!immutableTupleMatches) {
    const [blocked] = await db.update(signedDevisCopyNotices).set({
      status: "failed",
      lastError: "Reserved signed-copy outbox identity collided with a non-matching communication",
      updatedAt: new Date(),
    }).where(and(
      eq(signedDevisCopyNotices.id, notice.id),
      sql`${signedDevisCopyNotices.communicationId} IS NULL`,
    )).returning();
    return blocked ?? notice;
  }
  const linkedStatus =
    created.status === "sent" ? "sent"
    : created.status === "sending" ? "reconciling"
    : failure ? "failed"
    : "queued";
  const [updated] = await db.update(signedDevisCopyNotices).set({
    communicationId: created.id,
    status: linkedStatus,
    lastError: failure,
    sentAt: created.status === "sent" ? (created.sentAt ?? new Date()) : null,
    nextAttemptAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(signedDevisCopyNotices.id, notice.id),
    sql`${signedDevisCopyNotices.communicationId} IS NULL`,
  )).returning();
  return updated ?? await getSignedCopyNoticeForDevis(devisId);
}

/** Fail-closed checks run immediately before MIME assembly/provider use. */
export async function assertSignedCopyDispatchValid(
  communicationId: number,
): Promise<{ notice: SignedDevisCopyNotice; storageKey: string; recipientEmail: string }> {
  const [notice] = await db.select().from(signedDevisCopyNotices)
    .where(eq(signedDevisCopyNotices.communicationId, communicationId)).limit(1);
  if (!notice) throw new Error("Signed devis copy has no durable delivery intent");
  const setting = await getSignedCopySetting();
  if (!setting.enabled || !setting.activatedAt || Number.isNaN(new Date(setting.activatedAt).getTime())) {
    throw new Error("Automatic signed devis copies are disabled");
  }
  const d = await storage.getDevis(notice.devisId);
  const project = d ? await storage.getProject(d.projectId) : undefined;
  const contractor = notice.intendedContractorId
    ? await storage.getContractor(notice.intendedContractorId)
    : undefined;
  if (!d || !project || !contractor) throw new Error("Signed-copy devis, project, or intended contractor is unavailable");
  if (d.projectId !== notice.projectId) throw new Error("Project mismatch; signed-copy delivery is blocked");
  if (d.signOffStage !== "client_signed_off" || d.signedOffVia !== "archisign")
    throw new Error("Devis is not a verified Archisign completion");
  if (project.archivedAt) throw new Error("Project is archived; signed-copy delivery is blocked");
  if (d.archisignEnvelopeId !== notice.archisignEnvelopeId)
    throw new Error("Archisign envelope mismatch; signed-copy delivery is blocked");
  if (d.contractorId !== notice.intendedContractorId)
    throw new Error("Contractor assignment changed; signed-copy delivery is blocked");
  if (!d.signedPdfStorageKey || d.signedPdfArchisignEnvelopeId !== notice.archisignEnvelopeId)
    throw new Error("Verified Archisign signed PDF is unavailable or has mismatched provenance");
  const keys = await storage.getProjectCommunication(communicationId);
  if (!keys) throw new Error("Signed-copy communication is unavailable");
  const attachments = Array.isArray(keys?.attachmentStorageKeys) ? keys.attachmentStorageKeys : [];
  if (attachments.length !== 1 || attachments[0] !== d.signedPdfStorageKey)
    throw new Error("Signed-copy attachment does not match the verified Archisign PDF");
  const recipientEmail = (contractor.email ?? "").trim();
  if (!isValidRecipientEmail(recipientEmail)) throw new Error("Contractor email is missing or invalid");
  const ref = d.devisNumber || d.devisCode || `DV-${d.id}`;
  if (hasHeaderBreak(ref) || hasHeaderBreak(project.name)) {
    throw new Error("Devis reference or project name contains an invalid email-header line break");
  }
  const expectedSubject = subject(ref, project.name);
  const expectedBody = body(
    contractor.name,
    ref,
    project.name,
    signedCopyDeliveryReference(notice),
  );
  if (
    keys.projectId !== notice.projectId
    || keys.type !== "devis_signed_contractor_copy"
    || keys.recipientType !== "contractor"
    || keys.relatedDevisId !== notice.devisId
    || keys.dedupeKey !== `devis_signed_contractor_copy:${notice.devisId}:${notice.archisignEnvelopeId}`
    || keys.recipientName !== contractor.name
    || keys.subject !== expectedSubject
    || keys.body !== expectedBody
    || !keys.body.includes(`Référence de remise : ${signedCopyDeliveryReference(notice)}`)
  ) {
    throw new Error("Signed-copy communication immutable identity or content does not match its intent");
  }
  return { notice, storageKey: d.signedPdfStorageKey, recipientEmail };
}

async function markNoticeFailure(notice: SignedDevisCopyNotice, error: unknown): Promise<void> {
  const attempts = notice.attempts + 1;
  const terminal = attempts >= MAX_SIGNED_COPY_SEND_ATTEMPTS;
  const message = error instanceof Error ? error.message : String(error);
  await db.update(signedDevisCopyNotices).set({
    attempts,
    status: terminal ? "failed" : "queued",
    lastError: message,
    nextAttemptAt: new Date(Date.now() + (BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1])),
    updatedAt: new Date(),
  }).where(eq(signedDevisCopyNotices.id, notice.id));
}

export async function dispatchSignedCopyNotice(noticeId: number): Promise<void> {
  const setting = await getSignedCopySetting();
  if (
    !setting.enabled
    || !setting.activatedAt
    || Number.isNaN(new Date(setting.activatedAt).getTime())
  ) return;
  const [claimed] = await db.update(signedDevisCopyNotices).set({
    status: "sending",
    updatedAt: new Date(),
  }).where(and(
    eq(signedDevisCopyNotices.id, noticeId),
    inArray(signedDevisCopyNotices.status, ["queued", "reconciling"]),
  )).returning();
  if (!claimed?.communicationId) return;
  try {
    const { sendCommunication } = await import("../communications/email-sender");
    await sendCommunication(claimed.communicationId);
    const comm = await storage.getProjectCommunication(claimed.communicationId);
    await db.update(signedDevisCopyNotices).set({
      status: "sent",
      sentAt: comm?.sentAt ?? new Date(),
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(signedDevisCopyNotices.id, claimed.id));
  } catch (error) {
    const comm = await storage.getProjectCommunication(claimed.communicationId);
    if (comm?.status === "sending") {
      // Provider outcome is uncertain. Reconciliation may prove acceptance,
      // but this path never performs another provider send.
      const attempts = claimed.attempts + 1;
      const terminal = attempts >= MAX_SIGNED_COPY_SEND_ATTEMPTS;
      await db.update(signedDevisCopyNotices).set({
        status: "reconciling",
        attempts,
        lastError: terminal
          ? "Provider acceptance could not be confirmed after bounded reconciliation; resend remains blocked"
          : (error instanceof Error ? error.message : String(error)),
        nextAttemptAt: terminal
          ? new Date("9999-12-31T23:59:59.000Z")
          : new Date(Date.now() + BACKOFF_MS[Math.min(claimed.attempts, BACKOFF_MS.length - 1)]),
        updatedAt: new Date(),
      }).where(eq(signedDevisCopyNotices.id, claimed.id));
    } else {
      await markNoticeFailure(claimed, error);
    }
  }
}

export async function sweepSignedCopyNotices(limit = 20): Promise<void> {
  // Recover a crash after the communication sender committed but before the
  // notice status write (or while provider acceptance was uncertain).
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const stranded = await db.select().from(signedDevisCopyNotices)
    .where(and(
      eq(signedDevisCopyNotices.status, "sending"),
      lte(signedDevisCopyNotices.updatedAt, staleBefore),
    ))
    .limit(limit);
  for (const notice of stranded) {
    const comm = notice.communicationId
      ? await storage.getProjectCommunication(notice.communicationId)
      : undefined;
    await db.update(signedDevisCopyNotices).set(
      comm?.status === "sent"
        ? { status: "sent", sentAt: comm.sentAt ?? new Date(), lastError: null, updatedAt: new Date() }
        : { status: "reconciling", nextAttemptAt: new Date(), updatedAt: new Date() },
    ).where(and(
      eq(signedDevisCopyNotices.id, notice.id),
      eq(signedDevisCopyNotices.status, "sending"),
      lte(signedDevisCopyNotices.updatedAt, staleBefore),
    ));
  }
  // First recover the storage -> outbox crash gap, independently of Drive.
  const pending = await db.select({ id: signedDevisCopyNotices.id })
    .from(signedDevisCopyNotices)
    .where(and(
      eq(signedDevisCopyNotices.status, "pending_pdf"),
      lte(signedDevisCopyNotices.nextAttemptAt, new Date()),
    ))
    .orderBy(signedDevisCopyNotices.nextAttemptAt)
    .limit(limit);
  for (const row of pending) await materializeSignedCopyNotice(row.id);
  const due = await db.select({ id: signedDevisCopyNotices.id })
    .from(signedDevisCopyNotices)
    .where(and(
      inArray(signedDevisCopyNotices.status, ["queued", "reconciling"]),
      lte(signedDevisCopyNotices.nextAttemptAt, new Date()),
    )).limit(limit);
  for (const row of due) await dispatchSignedCopyNotice(row.id);
}

export async function retrySignedCopyNotice(devisId: number): Promise<SignedDevisCopyNotice | null> {
  let notice = await getSignedCopyNoticeForDevis(devisId);
  if (!notice) return null;
  if (notice.status === "reconciling" && notice.communicationId) {
    const communication = await storage.getProjectCommunication(notice.communicationId);
    if (communication?.status !== "sending") {
      throw new Error("Reconciliation state no longer matches the communication");
    }
    const [requeuedReconciliation] = await db.update(signedDevisCopyNotices).set({
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: "Operator requested another provider-acceptance reconciliation",
      updatedAt: new Date(),
    }).where(and(
      eq(signedDevisCopyNotices.id, notice.id),
      eq(signedDevisCopyNotices.status, "reconciling"),
    )).returning();
    return requeuedReconciliation ?? notice;
  }
  if (notice.status !== "failed") throw new Error("Only failed or reconciling signed-copy notices can be retried");
  // Re-materialize current address/safety state into the existing immutable
  // communication identity; never create a second outbox row.
  if (!notice.communicationId) {
    const setting = await getSignedCopySetting();
    if (!setting.enabled || !setting.activatedAt || Number.isNaN(new Date(setting.activatedAt).getTime())) {
      throw new Error("Automatic signed devis copies are disabled");
    }
    const d = await storage.getDevis(notice.devisId);
    const project = d ? await storage.getProject(d.projectId) : undefined;
    const contractor = await storage.getContractor(notice.intendedContractorId);
    if (!d || !project || !contractor) {
      throw new Error("Signed-copy devis, project, or intended contractor is unavailable");
    }
    if (project.archivedAt) throw new Error("Project is archived; signed-copy recovery is blocked");
    if (
      d.projectId !== notice.projectId
      || d.contractorId !== notice.intendedContractorId
      || d.archisignEnvelopeId !== notice.archisignEnvelopeId
      || d.signOffStage !== "client_signed_off"
      || d.signedOffVia !== "archisign"
    ) {
      throw new Error("Signed-copy recovery identity no longer matches the verified completion");
    }
    if (!isValidRecipientEmail((contractor.email ?? "").trim())) {
      throw new Error("Contractor email is missing or invalid");
    }
    const dueAt = new Date();
    const armed = await storage.resetSignedPdfPersistRetry(
      d.id,
      notice.archisignEnvelopeId,
      dueAt,
    );
    if (!armed) throw new Error("Verified Archisign PDF recovery could not be re-armed");
    const [pending] = await db.update(signedDevisCopyNotices).set({
      status: "pending_pdf",
      attempts: 0,
      lastError: "Operator re-armed verified Archisign PDF recovery",
      nextAttemptAt: dueAt,
      updatedAt: new Date(),
    }).where(and(
      eq(signedDevisCopyNotices.id, notice.id),
      eq(signedDevisCopyNotices.status, "failed"),
      sql`${signedDevisCopyNotices.communicationId} IS NULL`,
    )).returning();
    return pending ?? notice;
  }
  const currentCommunication = await storage.getProjectCommunication(notice.communicationId);
  if (currentCommunication?.status === "sending") {
    throw new Error(
      "Provider acceptance is unresolved; this delivery cannot be resent until reconciled",
    );
  }
  const validation = await assertSignedCopyDispatchValid(notice.communicationId);
  const updated = await db.transaction(async (tx) => {
    const [claimedNotice] = await tx.update(signedDevisCopyNotices).set({
      status: "queued",
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(signedDevisCopyNotices.id, notice!.id),
      eq(signedDevisCopyNotices.status, "failed"),
    )).returning();
    if (!claimedNotice) return undefined;
    const [comm] = await tx.update(projectCommunications).set({
      recipientEmail: validation.recipientEmail,
      status: "queued",
      archivedAt: null,
    }).where(and(
      eq(projectCommunications.id, notice!.communicationId!),
      eq(projectCommunications.status, "failed"),
    )).returning();
    if (!comm) throw new Error("Communication is no longer in a retryable state");
    return claimedNotice;
  });
  return updated ?? notice;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startSignedCopyNoticeSweeper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => void sweepSignedCopyNotices().catch((error) =>
    console.error("[SignedDevisCopy] sweep failed", error)), intervalMs);
}
