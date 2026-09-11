import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { getDocumentBuffer } from "../storage/object-storage";
import {
  projectCommunications,
  signedDevisCopyNotices,
  type Devis,
  type InsertProjectCommunication,
  type SignedDevisCopyNotice,
} from "@shared/schema";
import { isValidRecipientEmail } from "../communications/email-sender";
import {
  assertSignedCopyDispatchValid,
  dispatchSignedCopyNotice,
  hasVerifiedArchisignSignOff,
  listSignedCopyDeliveriesForDevis,
  SIGNED_COPY_MANUAL_SOURCE,
  storageKeyHash,
  subject,
  body,
} from "./signed-devis-contractor-copy.service";

export interface SignedCopyConfirmationSnapshot {
  devisId: number;
  projectId: number;
  contractorId: number;
  contractorName: string;
  recipientEmail: string;
  quotationRef: string;
  projectName: string;
  archisignEnvelopeId: string;
  signedPdfStorageKeyHash: string;
  signedPdfArchisignEnvelopeId: string;
  latestDeliveryId: number | null;
  latestDeliverySource: string | null;
  latestDeliveryStatus: string | null;
  latestDeliveryCommunicationId: number | null;
  requestedByUserId: number;
}

interface SignedCopyTokenPayload {
  version: 1;
  snapshot: Omit<SignedCopyConfirmationSnapshot, "requestedByUserId">;
}

interface SignedCopyCurrentState {
  devis: Devis;
  project: NonNullable<Awaited<ReturnType<typeof storage.getProject>>> | null;
  contractor: NonNullable<Awaited<ReturnType<typeof storage.getContractor>>> | null;
  recipientEmail: string;
  quotationRef: string;
  latestDelivery: SignedDevisCopyNotice | null;
}

function confirmationTokenSecret(): string {
  // SESSION_SECRET is boot-critical and is never exposed in the token. A
  // dedicated secret can be introduced later without invalidating the
  // durable snapshot contract.
  const secret = process.env.SIGNED_COPY_CONFIRMATION_SECRET || process.env.SESSION_SECRET;
  if (!secret) throw new Error("Signed-copy confirmation token secret is not configured");
  return secret;
}

function signConfirmationPayload(encodedPayload: string): string {
  return createHmac("sha256", confirmationTokenSecret())
    .update(encodedPayload)
    .digest("hex");
}

function mintSignedCopyConfirmationToken(
  snapshot: Omit<SignedCopyConfirmationSnapshot, "requestedByUserId">,
): string {
  const payload: SignedCopyTokenPayload = { version: 1, snapshot };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signConfirmationPayload(encoded)}`;
}

function verifySignedCopyConfirmationToken(token: string): SignedCopyTokenPayload | null {
  const [encoded, signature, ...extra] = token.split(".");
  if (
    !encoded
    || !signature
    || extra.length > 0
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
    || !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    return null;
  }
  const expected = signConfirmationPayload(encoded);
  const providedBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignedCopyTokenPayload;
    if (decoded?.version !== 1 || !decoded.snapshot || typeof decoded.snapshot !== "object") return null;
    return decoded;
  } catch {
    return null;
  }
}

function hasHeaderBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

async function loadSignedCopyCurrentState(
  devisId: number,
  latestDelivery?: SignedDevisCopyNotice | null,
): Promise<{ state: SignedCopyCurrentState | null; reason: string | null }> {
  const d = await storage.getDevis(devisId);
  const fallbackRef = d?.devisNumber || d?.devisCode || `DV-${devisId}`;
  if (!d) return { state: null, reason: "Devis not found" };
  const project = await storage.getProject(d.projectId);
  if (!project) return {
    state: {
      devis: d,
      project: null,
      contractor: null,
      recipientEmail: "",
      quotationRef: fallbackRef,
      latestDelivery: latestDelivery ?? null,
    },
    reason: "Project no longer exists",
  };
  const contractor = d.contractorId ? await storage.getContractor(d.contractorId) : undefined;
  const recipientEmail = (contractor?.email ?? "").trim();
  const quotationRef = d.devisNumber || d.devisCode || fallbackRef;
  const state: SignedCopyCurrentState = {
    devis: d,
    project,
    contractor: contractor ?? null,
    recipientEmail,
    quotationRef,
    latestDelivery: latestDelivery ?? null,
  };
  let reason: string | null = null;
  if (d.signOffStage !== "client_signed_off" || (d.signedOffVia !== "archisign" && d.signedOffVia !== null)) {
    reason = "Devis is not a verified Archisign completion";
  } else if (!d.archisignEnvelopeId) {
    reason = "Archisign envelope is unavailable";
  } else if (!d.signedPdfStorageKey || d.signedPdfArchisignEnvelopeId !== d.archisignEnvelopeId) {
    reason = "Verified Archisign signed PDF is unavailable or has mismatched provenance";
  } else if (!hasVerifiedArchisignSignOff(d)) {
    reason = "Verified Archisign signed PDF is unavailable or has mismatched provenance";
  } else if (project.archivedAt) {
    reason = "Project is archived; signed-copy delivery is blocked";
  } else if (!contractor) {
    reason = "Contractor no longer exists";
  } else if (!isValidRecipientEmail(recipientEmail)) {
    reason = "Contractor email is missing or invalid";
  } else if (hasHeaderBreak(quotationRef) || hasHeaderBreak(project.name)) {
    reason = "Devis reference or project name contains an invalid email-header line break";
  }
  if (!reason && d.signedPdfStorageKey) {
    try {
      // The provenance columns prove which PDF may be sent; this final
      // object-store read proves that the bytes are still available before
      // offering an operator a confirmation action.
      await getDocumentBuffer(d.signedPdfStorageKey);
    } catch {
      reason = "Verified Archisign signed PDF bytes are unavailable";
    }
  }
  return { state, reason };
}

function confirmationSnapshotFor(
  state: SignedCopyCurrentState,
  latestDelivery: SignedDevisCopyNotice | null,
  requestedByUserId: number,
): SignedCopyConfirmationSnapshot {
  const d = state.devis;
  const contractor = state.contractor!;
  const project = state.project!;
  return {
    devisId: d.id,
    projectId: d.projectId,
    contractorId: contractor.id,
    contractorName: contractor.name,
    recipientEmail: state.recipientEmail,
    quotationRef: state.quotationRef,
    projectName: project.name,
    archisignEnvelopeId: d.archisignEnvelopeId!,
    signedPdfStorageKeyHash: storageKeyHash(d.signedPdfStorageKey!),
    signedPdfArchisignEnvelopeId: d.signedPdfArchisignEnvelopeId!,
    latestDeliveryId: latestDelivery?.id ?? null,
    latestDeliverySource: latestDelivery?.source ?? null,
    latestDeliveryStatus: latestDelivery?.status ?? null,
    latestDeliveryCommunicationId: latestDelivery?.communicationId ?? null,
    requestedByUserId,
  };
}

function tokenSnapshotFrom(
  snapshot: SignedCopyConfirmationSnapshot,
): Omit<SignedCopyConfirmationSnapshot, "requestedByUserId"> {
  const { requestedByUserId: _requestedByUserId, ...tokenSnapshot } = snapshot;
  return tokenSnapshot;
}

function currentMatchesSnapshot(
  state: SignedCopyCurrentState,
  snapshot: Omit<SignedCopyConfirmationSnapshot, "requestedByUserId">,
  latestDelivery: SignedDevisCopyNotice | null,
): boolean {
  const d = state.devis;
  const contractor = state.contractor;
  const project = state.project;
  return !!contractor
    && !!project
    && snapshot.devisId === d.id
    && snapshot.projectId === d.projectId
    && snapshot.contractorId === contractor.id
    && snapshot.contractorName === contractor.name
    && snapshot.recipientEmail === state.recipientEmail
    && snapshot.quotationRef === state.quotationRef
    && snapshot.projectName === project.name
    && snapshot.archisignEnvelopeId === d.archisignEnvelopeId
    && snapshot.signedPdfStorageKeyHash === storageKeyHash(d.signedPdfStorageKey ?? "")
    && snapshot.signedPdfArchisignEnvelopeId === d.signedPdfArchisignEnvelopeId
    && snapshot.latestDeliveryId === (latestDelivery?.id ?? null)
    && snapshot.latestDeliverySource === (latestDelivery?.source ?? null)
    && snapshot.latestDeliveryStatus === (latestDelivery?.status ?? null)
    && snapshot.latestDeliveryCommunicationId === (latestDelivery?.communicationId ?? null);
}

export interface SignedCopyContractorCopyPayload {
  canSend: boolean;
  reason: string | null;
  contractorName: string | null;
  recipientEmail: string | null;
  quotationRef: string;
  confirmationToken: string | null;
  deliveries: Array<{
    id: number;
    status: string;
    recipientEmail: string | null;
    sentAt: string | null;
    lastError: string | null;
    communicationId: number | null;
    canRetry: boolean;
    source: string;
  }>;
}

async function deliveryResponse(
  row: SignedDevisCopyNotice,
): Promise<SignedCopyContractorCopyPayload["deliveries"][number]> {
  const communication = row.communicationId
    ? await storage.getProjectCommunication(row.communicationId)
    : undefined;
  const providerSending = communication?.status === "sending";
  return {
    id: row.id,
    status: row.status,
    recipientEmail: communication?.recipientEmail ?? null,
    sentAt: row.sentAt?.toISOString() ?? communication?.sentAt?.toISOString() ?? null,
    lastError: row.lastError,
    communicationId: row.communicationId,
    canRetry:
      row.status === "reconciling"
      || (row.status === "failed" && !providerSending),
    source: row.source,
  };
}

export async function getSignedCopyContractorCopyPayload(
  devisId: number,
): Promise<SignedCopyContractorCopyPayload> {
  const deliveries = await listSignedCopyDeliveriesForDevis(devisId);
  const latestDelivery = deliveries[0] ?? null;
  const { state, reason: validationReason } = await loadSignedCopyCurrentState(
    devisId,
    latestDelivery,
  );
  const quotationRef = state?.quotationRef ?? `DV-${devisId}`;
  const contractorName = state?.contractor?.name ?? null;
  const recipientEmail = state?.contractor ? state.recipientEmail || null : null;
  let reason = validationReason;
  if (!reason) {
    const communicationStates = await Promise.all(deliveries.map((delivery) =>
      delivery.communicationId
        ? storage.getProjectCommunication(delivery.communicationId)
        : Promise.resolve(undefined),
    ));
    const inFlightIndex = deliveries.findIndex((delivery, index) =>
      delivery.archisignEnvelopeId === state!.devis.archisignEnvelopeId
      && (
      ["pending_pdf", "queued", "sending", "reconciling"].includes(delivery.status)
      || communicationStates[index]?.status === "sending"
      ),
    );
    const inFlight = inFlightIndex >= 0 ? deliveries[inFlightIndex] : undefined;
    if (inFlight) {
      reason = inFlight.status === "reconciling"
        ? "Provider acceptance is unresolved; reconcile the existing delivery before sending another copy"
        : "A signed-copy delivery is already in progress";
    }
  }
  const canSend = !reason && !!state;
  let confirmationToken: string | null = null;
  if (canSend) {
    const snapshot = confirmationSnapshotFor(state!, latestDelivery, 0);
    confirmationToken = mintSignedCopyConfirmationToken(tokenSnapshotFrom(snapshot));
  }
  return {
    canSend,
    reason,
    contractorName,
    recipientEmail,
    quotationRef,
    confirmationToken,
    deliveries: await Promise.all(deliveries.map(deliveryResponse)),
  };
}

export async function createManualSignedCopyDelivery(options: {
  devisId: number;
  requestId: string;
  confirmationToken: string;
  requestedByUserId: number;
}): Promise<SignedDevisCopyNotice> {
  const tokenPayload = verifySignedCopyConfirmationToken(options.confirmationToken);
  if (!tokenPayload || tokenPayload.snapshot.devisId !== options.devisId) {
    throw new Error("Signed-copy confirmation is invalid or expired");
  }

  let created: SignedDevisCopyNotice | undefined;
  await db.transaction(async (tx) => {
    // This is the same lock automatic dispatch takes before claiming an
    // automatic notice. It intentionally covers the row even when no
    // automatic notice exists yet (historical/manual-only completion).
    await tx.execute(sql`SELECT id FROM devis WHERE id = ${options.devisId} FOR UPDATE`);

    const [existingRequest] = await tx.select().from(signedDevisCopyNotices)
      .where(and(
        eq(signedDevisCopyNotices.source, SIGNED_COPY_MANUAL_SOURCE),
        eq(signedDevisCopyNotices.requestId, options.requestId),
      ))
      .limit(1);
    if (existingRequest) {
      if (existingRequest.devisId !== options.devisId) {
        throw new Error("This confirmation request was already used for another devis");
      }
      created = existingRequest;
      return;
    }

    const deliveries = await listSignedCopyDeliveriesForDevis(options.devisId);
    const latestDelivery = deliveries[0] ?? null;
    const { state, reason } = await loadSignedCopyCurrentState(options.devisId, latestDelivery);
    if (!state || reason) throw new Error(reason ?? "Signed-copy delivery is unavailable");
    if (!currentMatchesSnapshot(state, tokenPayload.snapshot, latestDelivery)) {
      throw new Error("Signed-copy confirmation is stale; refresh the delivery panel and confirm again");
    }
    const communicationStates = await Promise.all(deliveries.map((delivery) =>
      delivery.communicationId
        ? storage.getProjectCommunication(delivery.communicationId)
        : Promise.resolve(undefined),
    ));
    const unresolvedIndex = deliveries.findIndex((delivery, index) =>
      delivery.archisignEnvelopeId === state.devis.archisignEnvelopeId
      && (
        ["pending_pdf", "queued", "sending", "reconciling"].includes(delivery.status)
        || communicationStates[index]?.status === "sending"
      ),
    );
    const unresolved = unresolvedIndex >= 0 ? deliveries[unresolvedIndex] : undefined;
    if (unresolved) {
      throw new Error(
        unresolved.status === "reconciling"
          ? "Provider acceptance is unresolved; reconcile the existing delivery before sending another copy"
          : "A signed-copy delivery is already in progress",
      );
    }
    if (!state.devis.contractorId || !state.devis.archisignEnvelopeId || !state.devis.signedPdfStorageKey) {
      throw new Error("Verified Archisign signed PDF is unavailable");
    }

    const snapshot = confirmationSnapshotFor(state, latestDelivery, options.requestedByUserId);
    const communicationValues: InsertProjectCommunication & { relatedDevisId: number } = {
      projectId: state.devis.projectId,
      type: "devis_signed_contractor_copy",
      recipientType: "contractor",
      recipientEmail: state.recipientEmail,
      recipientName: state.contractor!.name,
      subject: subject(state.quotationRef, state.project!.name),
      body: body(
        state.contractor!.name,
        state.quotationRef,
        state.project!.name,
        // The notice ID is not known until after the insert. The request
        // identity is stable and non-secret, so use it only for the initial
        // body marker; dispatch validation still checks the row identity.
        `AT-DV-${createHash("sha256").update(options.requestId).digest("hex").slice(0, 20)}`,
      ),
      attachmentStorageKeys: [state.devis.signedPdfStorageKey],
      status: "queued",
      relatedDevisId: state.devis.id,
      dedupeKey: `devis_signed_contractor_copy:manual:${options.requestId}`,
    };
    const [communication] = await tx.insert(projectCommunications)
      .values(communicationValues)
      .onConflictDoNothing({ target: projectCommunications.dedupeKey })
      .returning();
    const durableCommunication = communication ?? (await tx.select().from(projectCommunications)
      .where(eq(projectCommunications.dedupeKey, communicationValues.dedupeKey!))
      .limit(1))[0];
    if (!durableCommunication) throw new Error("Could not persist signed-copy communication identity");
    if (
      durableCommunication.projectId !== communicationValues.projectId
      || durableCommunication.type !== communicationValues.type
      || durableCommunication.recipientType !== communicationValues.recipientType
      || durableCommunication.recipientEmail !== communicationValues.recipientEmail
      || durableCommunication.recipientName !== communicationValues.recipientName
      || durableCommunication.subject !== communicationValues.subject
      || durableCommunication.body !== communicationValues.body
      || durableCommunication.relatedDevisId !== communicationValues.relatedDevisId
      || durableCommunication.dedupeKey !== communicationValues.dedupeKey
      || !Array.isArray(durableCommunication.attachmentStorageKeys)
      || durableCommunication.attachmentStorageKeys.length !== 1
      || durableCommunication.attachmentStorageKeys[0] !== state.devis.signedPdfStorageKey
    ) {
      throw new Error("Reserved signed-copy outbox identity collided with a non-matching communication");
    }

    const [inserted] = await tx.insert(signedDevisCopyNotices).values({
      devisId: state.devis.id,
      projectId: state.devis.projectId,
      archisignEnvelopeId: state.devis.archisignEnvelopeId,
      intendedContractorId: state.devis.contractorId,
      signedAt: latestDelivery?.signedAt ?? new Date(),
      source: SIGNED_COPY_MANUAL_SOURCE,
      requestId: options.requestId,
      requestedByUserId: options.requestedByUserId,
      confirmationSnapshot: snapshot,
      status: "queued",
      communicationId: durableCommunication.id,
      nextAttemptAt: new Date(),
    })
      .onConflictDoNothing({
        target: signedDevisCopyNotices.requestId,
        where: sql`${signedDevisCopyNotices.source} = 'manual' AND ${signedDevisCopyNotices.requestId} IS NOT NULL`,
      })
      .returning();
    if (inserted) {
      created = inserted;
      return;
    }
    const [raced] = await tx.select().from(signedDevisCopyNotices)
      .where(and(
        eq(signedDevisCopyNotices.source, SIGNED_COPY_MANUAL_SOURCE),
        eq(signedDevisCopyNotices.requestId, options.requestId),
      ))
      .limit(1);
    if (!raced) throw new Error("Could not persist signed-copy delivery identity");
    if (raced.devisId !== options.devisId) {
      throw new Error("This confirmation request was already used for another devis");
    }
    created = raced;
  });

  if (!created) throw new Error("Could not create signed-copy delivery");
  await dispatchSignedCopyNotice(created.id, { sentByUserId: created.requestedByUserId });
  const [updated] = await db.select().from(signedDevisCopyNotices)
    .where(eq(signedDevisCopyNotices.id, created.id))
    .limit(1);
  return updated ?? created;
}

export async function retrySignedCopyDelivery(
  noticeId: number,
  expectedDevisId?: number,
): Promise<SignedDevisCopyNotice | null> {
  const [notice] = await db.select().from(signedDevisCopyNotices)
    .where(eq(signedDevisCopyNotices.id, noticeId))
    .limit(1);
  if (!notice) return null;
  if (expectedDevisId !== undefined && notice.devisId !== expectedDevisId) return null;
  if (notice.source !== SIGNED_COPY_MANUAL_SOURCE) {
    throw new Error("Automatic signed-copy notices use their protected retry endpoint");
  }
  if (notice.status === "reconciling") {
    const communication = notice.communicationId
      ? await storage.getProjectCommunication(notice.communicationId)
      : undefined;
    if (communication?.status !== "sending") {
      throw new Error("Reconciliation state no longer matches the communication");
    }
    await dispatchSignedCopyNotice(notice.id, { sentByUserId: notice.requestedByUserId });
  } else if (notice.status === "failed") {
    if (!notice.communicationId) throw new Error("Manual signed-copy delivery has no communication");
    const communication = await storage.getProjectCommunication(notice.communicationId);
    if (communication?.status === "sending") {
      throw new Error("Provider acceptance is unresolved; reconcile this delivery before retrying");
    }
    await assertSignedCopyDispatchValid(notice.communicationId);
    const requeued = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM devis WHERE id = ${notice.devisId} FOR UPDATE`);
      const [claimed] = await tx.update(signedDevisCopyNotices).set({
        status: "queued",
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(signedDevisCopyNotices.id, notice.id),
        eq(signedDevisCopyNotices.status, "failed"),
      )).returning();
      if (!claimed) return undefined;
      const [comm] = await tx.update(projectCommunications).set({
        status: "queued",
        archivedAt: null,
      }).where(and(
        eq(projectCommunications.id, notice.communicationId!),
        eq(projectCommunications.status, "failed"),
      )).returning();
      if (!comm) throw new Error("Communication is no longer in a retryable state");
      return claimed;
    });
    if (requeued) {
      await dispatchSignedCopyNotice(requeued.id, { sentByUserId: requeued.requestedByUserId });
    }
  } else {
    throw new Error("Only failed or unresolved manual signed-copy deliveries can be retried");
  }
  const [updated] = await db.select().from(signedDevisCopyNotices)
    .where(eq(signedDevisCopyNotices.id, notice.id))
    .limit(1);
  return updated ?? notice;
}