import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getUncachableGmailClient, isGmailConfigured, isFakeGmailMode } from "../gmail/client";
import { getGmailClientForUser } from "../gmail/user-client";
import { storage } from "../storage";
import { buildCertificatEmailBody } from "./certificat-generator";
import { sealCertificat } from "../services/certificat-seal.service";
import { getDocumentBuffer, uploadDocument } from "../storage/object-storage";
import { env } from "../env";
import type { InsertProjectCommunication } from "@shared/schema";
import { CLIENT_NO_PAYMENT_NOTICE } from "@shared/signature-message-template";

/**
 * Task #225 — Pull the contractor's RIB (PDF of bank-account details)
 * through the authenticated ArchiDoc proxy and mirror it into our
 * object storage so it can be attached to the certificat email and
 * land in the lot's Drive folder alongside the certificat itself.
 *
 * `ribDocumentUrl` from ArchiDoc is treated as a path relative to
 * ARCHIDOC_BASE_URL (the proxy that re-signs on every fetch) — we
 * never trust it as an absolute URL to an unknown host. Failure to
 * mirror is non-fatal: the certificat email still goes out, just
 * without the RIB. The architect always has the IBAN block printed
 * on the certificat PDF itself.
 */
async function mirrorRibForAttachment(args: {
  projectId: number;
  ribDocumentUrl: string;
  ribDocumentName: string | null;
}): Promise<string | null> {
  const baseUrl = env.ARCHIDOC_BASE_URL;
  const apiKey = env.ARCHIDOC_SYNC_API_KEY;
  if (!baseUrl || !apiKey) return null;
  try {
    const url = new URL(args.ribDocumentUrl, baseUrl);
    if (new URL(baseUrl).host !== url.host) {
      console.warn(`[Certificat] Refusing to fetch RIB from foreign host ${url.host}`);
      return null;
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`[Certificat] RIB fetch ${res.status} from ${url.pathname}`);
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const fileName = args.ribDocumentName || `RIB.pdf`;
    return await uploadDocument(args.projectId, fileName, buffer, "application/pdf");
  } catch (err: unknown) {
    console.warn(`[Certificat] RIB mirror failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Task #269 — subject of the certificat email sent to the client.
 * "Certificat de Paiement" is a preserved French domain term (see
 * replit.md user prefs); everything else stays English. Exported for
 * the English-copy regression guard.
 */
export function buildCertificatEmailSubject(opts: {
  certificateRef: string;
  projectName: string;
}): string {
  return `Certificat de Paiement ${opts.certificateRef} - ${opts.projectName}`;
}

/**
 * Task #519 — strict single-address validation before ANY raw RFC-2822
 * assembly. `includes("@")` is not validation: CR/LF in a stored address
 * would inject headers into the hand-built `To:` line. One address only —
 * no display names, no commas/semicolons, no angle brackets, no whitespace.
 * Exported for unit tests.
 */
export function isValidRecipientEmail(addr: string): boolean {
  if (!addr || /[\r\n]/.test(addr)) return false;
  return /^[^\s@,;<>"()[\]\\]+@[^\s@,;<>"()[\]\\]+\.[A-Za-z0-9-]{2,}$/.test(addr);
}

/**
 * Task #519 — subject/body of the contractor payment-notice email queued
 * alongside every certificat client send. Contractor-facing → French (like
 * the devis-check bundle). The body invites a plain REPLY on receipt of the
 * payment; the reply-scan (detectReceivedConfirmation) watches this thread
 * and turns matching replies into `contractor_received` suggestions.
 * Exported for unit tests.
 */
export function buildContractorNoticeEmailSubject(opts: {
  certificateRef: string;
  projectName: string;
}): string {
  return `Certificat de Paiement ${opts.certificateRef} – ${opts.projectName} – Paiement demandé au client`;
}

export function buildContractorNoticeEmailBody(opts: {
  contractorName: string;
  certificateRef: string;
  projectName: string;
  netToPayTtc: string;
}): string {
  const n = Number(opts.netToPayTtc);
  const amount = Number.isFinite(n)
    ? new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
    : opts.netToPayTtc;
  return (
    `Bonjour ${opts.contractorName},\n\n` +
    `Nous vous informons que le certificat de paiement ${opts.certificateRef} concernant le projet ` +
    `« ${opts.projectName} » a été transmis ce jour au maître d'ouvrage, avec instruction de régler ` +
    `la somme de ${amount} € TTC en votre faveur.\n\n` +
    `Afin de nous permettre de suivre ce règlement, nous vous remercions de répondre simplement à ` +
    `cet e-mail dès réception du paiement (par exemple : « Paiement bien reçu le JJ/MM/AAAA »).\n\n` +
    `N'hésitez pas à nous signaler tout retard de règlement.\n\n` +
    `Cordialement,\nSAS Architects-France\n`
  );
}

export async function sendCertificat(certificatId: number): Promise<number> {
  // Task #451 — issuance seal FIRST: render once, pin the bytes. Re-sends
  // and concurrent sends all attach the same pinned PDF (idempotent inside
  // sealCertificat via a version-guarded conditional single-writer UPDATE).
  // The email subject/body are then built from the SEALED row — never from
  // a pre-seal fetch — so message amounts always match the attached PDF.
  const { pdfStorageKey: storageKey, certificat } = await sealCertificat(certificatId);

  const project = await storage.getProject(certificat.projectId);
  if (!project) throw new Error(`Project not found`);

  const contractor = await storage.getContractor(certificat.contractorId);
  if (!contractor) throw new Error(`Contractor not found`);

  // Task #478 — the recipient is the client's CONTACT EMAIL, never
  // clientAddress (a postal address in real data). Fail loudly when it is
  // missing rather than queueing an email Gmail will reject or misroute —
  // and that the payment-reply scanner could never match.
  const recipientEmail = (project.clientContactEmail ?? "").trim();
  if (!recipientEmail || !recipientEmail.includes("@")) {
    throw new Error(
      `Client contact email missing or invalid on project "${project.name}" — set it on the project before sending the certificat`,
    );
  }

  const subject = buildCertificatEmailSubject({
    certificateRef: certificat.certificateRef,
    projectName: project.name,
  });
  const body = buildCertificatEmailBody({ certificat, project, contractor });

  // Task #225 — attach the contractor's RIB alongside the certificat so
  // the client has the bank details in a separate document the bank can
  // file as a single PDF. Non-fatal on failure.
  const attachmentStorageKeys: string[] = [storageKey];
  if (contractor.ribDocumentUrl) {
    const ribKey = await mirrorRibForAttachment({
      projectId: project.id,
      ribDocumentUrl: contractor.ribDocumentUrl,
      ribDocumentName: contractor.ribDocumentName,
    });
    if (ribKey) attachmentStorageKeys.push(ribKey);
  }

  const comm: InsertProjectCommunication = {
    projectId: project.id,
    type: "certificat_sent",
    recipientType: "client",
    recipientEmail,
    recipientName: project.clientName,
    subject,
    body,
    attachmentStorageKeys,
    status: "queued",
    relatedCertificatId: certificatId,
    // Task #451 — idempotent under concurrent send: the dedupe key is stable
    // per issuance (certificat + pinned bytes), so racing send requests hit
    // the unique index in createProjectCommunication and share ONE queued
    // email instead of each enqueuing a duplicate payment instruction.
    dedupeKey: `certificat_sent:${certificatId}:${storageKey}`,
  };

  let created = await storage.createProjectCommunication(comm);

  // Task #539 — retryability: the stable dedupe key means a PREVIOUSLY
  // FAILED client send returns the existing failed row instead of inserting
  // a new one. A "Send" click must then actually requeue that row (also
  // clearing any archive flag via updateProjectCommunication), not report
  // success while nothing is pending. queued/sent rows pass through
  // untouched — that is the idempotent double-click case.
  // Task #543 — the requeue is a conditional CAS (WHERE status='failed'):
  // a concurrent retry that lost the race must NOT stomp a row already
  // claimed into 'sending' back to 'queued' (that would let a second
  // dispatch claim succeed and email a duplicate payment instruction).
  if (created.status === "failed") {
    const requeued = await storage.requeueFailedProjectCommunication(created.id);
    if (requeued) created = requeued;
  }

  // Task #519 — queue the contractor payment notice alongside the client
  // send. Never blocks the client certificat: a missing/invalid contractor
  // email queues a FAILED communication row (visible in the hub, retryable
  // once the email is fixed) instead of silently skipping. Same stable
  // dedupe key scheme as the client comm, so re-sends share one row.
  const contractorEmail = (contractor.email ?? "").trim();
  const contractorEmailValid = isValidRecipientEmail(contractorEmail);
  await storage.createProjectCommunication({
    projectId: project.id,
    type: "certificat_contractor_notice",
    recipientType: "contractor",
    recipientEmail: contractorEmail,
    recipientName: contractor.name,
    subject: buildContractorNoticeEmailSubject({
      certificateRef: certificat.certificateRef,
      projectName: project.name,
    }),
    body: buildContractorNoticeEmailBody({
      contractorName: contractor.name,
      certificateRef: certificat.certificateRef,
      projectName: project.name,
      netToPayTtc: certificat.netToPayTtc,
    }),
    status: contractorEmailValid ? "queued" : "failed",
    relatedCertificatId: certificatId,
    dedupeKey: `certificat_contractor_notice:${certificatId}:${storageKey}`,
  });
  if (!contractorEmailValid) {
    console.warn(
      `[Certificat] Contractor "${contractor.name}" has no valid email — contractor payment notice for ${certificat.certificateRef} queued as FAILED (fix the contractor email, then retry the send from the communications hub)`,
    );
  }

  // NB: Drive enqueue happens inside the issuance render (Task #198 /
  // Task #451) — previews no longer persist or mirror anything.
  return created.id;
}

/**
 * Task #443 — bundled static email attachments.
 *
 * Attachment keys in `attachmentStorageKeys` normally reference object
 * storage. Keys prefixed `asset:` instead resolve to files bundled with
 * the server in `server/assets/` — used for standard documents that ship
 * with the app (e.g. the client signing-and-payment explainer PDF) and
 * must never depend on object-storage state. The part after the prefix
 * is both the file name on disk and the filename the recipient sees.
 */
export const ASSET_ATTACHMENT_PREFIX = "asset:";

/** The one-page client explainer attached to every signature-context email. */
export const SIGNING_EXPLAINER_ATTACHMENT_KEY =
  `${ASSET_ATTACHMENT_PREFIX}How-signing-and-payment-works.pdf`;

/** Maps the shipped attachment filename to its on-disk asset file. */
const ASSET_FILE_BY_NAME: Record<string, string> = {
  "How-signing-and-payment-works.pdf": "how-signing-and-payment-works.pdf",
};

function resolveAssetsFolder(): string {
  const candidates: string[] = [];
  try {
    const here = typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
    // Production: dist/index.cjs (__dirname = dist) with assets copied to
    // dist/assets by script/build.ts. Dev (tsx): this file lives in
    // server/communications, so ../assets = server/assets.
    candidates.push(path.resolve(here, "assets"));
    candidates.push(path.resolve(here, "..", "assets"));
  } catch {
    // fall through to cwd candidates
  }
  candidates.push(path.resolve(process.cwd(), "server", "assets"));
  candidates.push(path.resolve(process.cwd(), "dist", "assets"));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

/** Exported for tests. Throws when the asset is unknown or missing on disk. */
export function loadAssetAttachment(key: string): { filename: string; buffer: Buffer } {
  const filename = key.slice(ASSET_ATTACHMENT_PREFIX.length);
  const diskName = ASSET_FILE_BY_NAME[filename];
  if (!diskName) throw new Error(`Unknown bundled asset attachment: ${filename}`);
  const filePath = path.join(resolveAssetsFolder(), diskName);
  return { filename, buffer: fs.readFileSync(filePath) };
}

/**
 * Task #543 — thrown when another request holds the dispatch claim for the
 * same communication row. Callers treat this as "already being sent right
 * now": no duplicate email went out and nothing needs retrying.
 */
export class CommunicationSendInProgressError extends Error {
  constructor(public readonly communicationId: number) {
    super("This communication is already being sent");
    this.name = "CommunicationSendInProgressError";
  }
}

export async function sendCommunication(
  communicationId: number,
  opts?: { threadId?: string | null; inReplyToMessageId?: string | null; sentByUserId?: number | null },
): Promise<void> {
  // Task #543 — atomic dispatch claim BEFORE any Gmail work. The conditional
  // queued/failed/draft → 'sending' compare-and-set in storage guarantees
  // exactly one caller dispatches a given row: concurrent send requests
  // (double-click, browser retry, two surfaces at once) all race on the same
  // stable-dedupe row, and every loser gets a loud error here instead of
  // sending a duplicate payment instruction. Retrying a previously FAILED
  // send is still allowed (failed is a claimable state); only terminal
  // 'sent' and an in-flight 'sending' are blocked.
  const comm = await storage.claimProjectCommunicationForSending(communicationId);
  if (!comm) {
    const current = await storage.getProjectCommunication(communicationId);
    if (!current) throw new Error(`Communication ${communicationId} not found`);
    if (current.status === "sent") {
      throw new Error(`Communication is already sent`);
    }
    if (current.status === "sending") {
      throw new CommunicationSendInProgressError(communicationId);
    }
    throw new Error(
      `Communication ${communicationId} is not in a sendable state (status: ${current.status})`,
    );
  }

  // Task #519/521 — a communication can be queued as `failed` precisely
  // because the recipient email is missing or was wrong (contractor notice
  // without an email on file, or with a stale address). Guard every send so
  // Gmail never receives an empty or header-injectable To: value.
  //
  // For contractor notices, ALWAYS re-resolve the address from the linked
  // contractor record and use it unconditionally — never fall back to the
  // previously stored value. This ensures:
  //   (a) fixing the contractor email makes the retry succeed, and
  //   (b) clearing or invalidating it after a prior valid send fails closed
  //       rather than disclosing payment content to a stale address.
  let recipient = (comm.recipientEmail ?? "").trim();
  if (comm.type === "certificat_contractor_notice") {
    // Every contractor notice MUST have a linked certificat so we can look up
    // the contractor's current email. A notice with no cert link cannot be
    // safely sent — there is no trusted source for the recipient — so we
    // fail closed rather than using whatever stale address the row holds.
    if (!comm.relatedCertificatId) {
      await storage.updateProjectCommunication(communicationId, { status: "failed" });
      throw new Error(
        "Contractor payment notice has no linked certificat — cannot resolve recipient address; inspect the communications row and retry",
      );
    }
    const cert = await storage.getCertificat(comm.relatedCertificatId);
    const contractor = cert ? await storage.getContractor(cert.contractorId) : undefined;
    const fresh = (contractor?.email ?? "").trim();
    // Unconditionally replace recipient — if fresh is invalid the guard below
    // will fail closed. Persist only when the address actually changed so
    // the comm row reflects the address that was (or would be) used.
    if (fresh !== recipient) {
      await storage.updateProjectCommunication(communicationId, { recipientEmail: fresh });
      comm.recipientEmail = fresh;
    }
    recipient = fresh;
  }
  if (!isValidRecipientEmail(recipient)) {
    await storage.updateProjectCommunication(communicationId, { status: "failed" });
    throw new Error(
      `Recipient email missing or invalid for this communication — set the ${comm.recipientType === "contractor" ? "contractor's" : "recipient's"} email, then retry`,
    );
  }

  try {
    // Task #466 — send through the INITIATING architect's linked Gmail
    // client when they have one (gmail.modify scope includes send). Sending
    // from their linked mailbox means client replies land in a mailbox we
    // can READ, so the payment-reply scanner can watch the thread;
    // `sentViaUserId` binds the communication to that mailbox. Explicit
    // fallback: if the caller passed no user, or that user has not linked
    // Gmail (or their client fails), send via the shared Replit connector —
    // which requires the connector to be configured — and leave
    // `sentViaUserId` null (legacy probe-every-inbox scan path). We never
    // substitute a DIFFERENT user's mailbox: that would attribute the
    // thread to someone who didn't send it and scan the wrong inbox.
    let gmail: Awaited<ReturnType<typeof getUncachableGmailClient>> | null = null;
    let sentViaUserId: number | null = null;
    if (!isFakeGmailMode() && opts?.sentByUserId) {
      const sender = await storage.getUser(opts.sentByUserId);
      if (sender?.gmailRefreshToken) {
        try {
          gmail = await getGmailClientForUser(sender);
          sentViaUserId = sender.id;
        } catch (err) {
          console.error(`[EmailSender] Linked Gmail client failed for sender ${sender.id}, falling back to connector:`, err);
        }
      }
    }
    if (!gmail) {
      if (!isGmailConfigured()) {
        throw new Error("Gmail not configured: no linked mailbox for the sender and the shared Gmail connector is not set up");
      }
      gmail = await getUncachableGmailClient();
    }

    const attachments: Array<{ filename: string; content: string; contentType: string }> = [];
    const storageKeys = (comm.attachmentStorageKeys as string[]) || [];

    for (const key of storageKeys) {
      // Bundled assets are REQUIRED attachments: failing to load one is a
      // deployment problem (missing file) and must fail the send — silently
      // dropping e.g. the signing explainer would defeat its purpose. This
      // load intentionally sits OUTSIDE the best-effort try/catch below, so
      // a failure propagates and marks the communication `failed`.
      if (key.startsWith(ASSET_ATTACHMENT_PREFIX)) {
        const asset = loadAssetAttachment(key);
        attachments.push({
          filename: asset.filename,
          content: asset.buffer.toString("base64"),
          contentType: "application/pdf",
        });
        continue;
      }
      try {
        const buffer = await getDocumentBuffer(key);
        const filename = key.split("/").pop() || "attachment";
        let contentType = "application/octet-stream";
        if (filename.endsWith(".pdf")) contentType = "application/pdf";
        else if (filename.endsWith(".html")) contentType = "text/html";
        attachments.push({
          filename,
          content: buffer.toString("base64"),
          contentType,
        });
      } catch (err) {
        console.error(`[EmailSender] Failed to load attachment ${key}:`, err);
      }
    }

    const boundary = `boundary_${Date.now()}`;
    let rawEmail = [
      `From: me`,
      `To: ${comm.recipientEmail || ""}`,
      `Subject: ${comm.subject}`,
      `MIME-Version: 1.0`,
    ];
    // Thread-reuse headers for follow-up bundled sends. Gmail also needs the
    // thread id passed in the API call, but In-Reply-To/References make the
    // resulting message render as a reply in any IMAP client too.
    if (opts?.inReplyToMessageId) {
      const mid = opts.inReplyToMessageId.startsWith("<") ? opts.inReplyToMessageId : `<${opts.inReplyToMessageId}>`;
      rawEmail.push(`In-Reply-To: ${mid}`);
      rawEmail.push(`References: ${mid}`);
    }

    if (attachments.length > 0) {
      rawEmail.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      rawEmail.push("");
      rawEmail.push(`--${boundary}`);
      rawEmail.push(`Content-Type: text/plain; charset="UTF-8"`);
      rawEmail.push("");
      rawEmail.push(comm.body || "");

      for (const att of attachments) {
        rawEmail.push(`--${boundary}`);
        rawEmail.push(`Content-Type: ${att.contentType}; name="${att.filename}"`);
        rawEmail.push(`Content-Disposition: attachment; filename="${att.filename}"`);
        rawEmail.push(`Content-Transfer-Encoding: base64`);
        rawEmail.push("");
        rawEmail.push(att.content);
      }
      rawEmail.push(`--${boundary}--`);
    } else {
      rawEmail.push(`Content-Type: text/plain; charset="UTF-8"`);
      rawEmail.push("");
      rawEmail.push(comm.body || "");
    }

    const encodedMessage = Buffer.from(rawEmail.join("\r\n")).toString("base64url");

    const requestBody: { raw: string; threadId?: string } = { raw: encodedMessage };
    if (opts?.threadId) requestBody.threadId = opts.threadId;
    const sendResult = await gmail.users.messages.send({
      userId: "me",
      requestBody,
    });

    await storage.updateProjectCommunication(communicationId, {
      status: "sent",
      sentAt: new Date(),
      emailMessageId: sendResult.data.id || undefined,
      emailThreadId: sendResult.data.threadId || undefined,
      sentViaUserId,
    });

    console.log(`[EmailSender] Sent communication ${communicationId}: ${comm.subject}`);
  } catch (err: unknown) {
    await storage.updateProjectCommunication(communicationId, {
      status: "failed",
    });
    throw err;
  }

  // Task #519 — the contractor payment notice rides along with the client
  // certificat send: once the certificat email actually goes out, dispatch
  // the queued sibling notice automatically. Failure is ISOLATED — the
  // client send already succeeded, and a failed notice stays visible and
  // retryable in the communications hub. Only certificat_sent triggers the
  // chain, so there is no recursion.
  if (comm.type === "certificat_sent" && comm.relatedCertificatId) {
    try {
      const notice = await storage.getQueuedContractorNoticeForCertificat(comm.relatedCertificatId);
      if (notice) {
        await sendCommunication(notice.id, { sentByUserId: opts?.sentByUserId ?? null });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[EmailSender] Contractor payment notice for certificat ${comm.relatedCertificatId} failed (client send unaffected): ${message}`,
      );
    }
  }
}

/**
 * Format a single check's head line for the bundled email body. Exported so
 * unit tests can assert the French formatting without spinning up storage.
 *
 * Line-scoped questions render as `Ligne {n} — {description} ({amount} € HT)`
 * so the contractor can correlate against the actual line position on their
 * devis PDF (the bundle order on its own is not enough — see Task #110).
 * General questions render as `Question générale` with no line prefix.
 */
export function formatCheckHead(c: {
  lineDescription: string | null;
  lineNumber: number | null;
  totalHt: string | null;
}): string {
  if (c.lineNumber == null || !c.lineDescription) return "Question générale";
  const amount = formatHtAmount(c.totalHt);
  const tail = amount ? ` (${amount} € HT)` : "";
  return `Ligne ${c.lineNumber} — ${c.lineDescription}${tail}`;
}

function formatHtAmount(raw: string | null): string | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

/**
 * Bundled French "questions sur le devis" email to a single contractor.
 * Idempotent via `dedupeKey` on `project_communications` — if a queued/sent
 * row with the same key exists, we re-use it (no duplicate Gmail send).
 *
 * The email is intentionally text-only and does NOT include the PDF as an
 * attachment — the contractor opens the portal link to view it. The portal
 * is the only channel for contractor replies.
 */
export async function queueDevisCheckBundle(opts: {
  devisId: number;
  portalUrl: string;
  dedupeKey: string;
  checkSummaries: Array<{
    query: string;
    lineDescription: string | null;
    lineNumber: number | null;
    totalHt: string | null;
  }>;
}): Promise<{
  communicationId: number;
  alreadySent: boolean;
  refreshedSubject: string;
  refreshedBody: string;
}> {
  const devis = await storage.getDevis(opts.devisId);
  if (!devis) throw new Error(`Devis ${opts.devisId} not found`);
  const project = await storage.getProject(devis.projectId);
  if (!project) throw new Error("Project not found");
  const contractor = await storage.getContractor(devis.contractorId);
  if (!contractor) throw new Error("Contractor not found");

  const refLabel = devis.devisNumber || devis.devisCode;
  const subject = `Questions sur le devis ${refLabel} — ${project.name}`;

  const itemLines = opts.checkSummaries
    .map((c) => {
      const head = formatCheckHead(c);
      return `${head}\n   → ${c.query}`;
    })
    .join("\n\n");

  const greeting = `Bonjour ${contractor.name},`;
  const intro = `Nous avons quelques questions concernant votre devis ${refLabel} pour le projet « ${project.name} ».`;
  const portalNote = `Merci de répondre directement via l'espace dédié (les réponses par email ne sont pas suivies) :\n${opts.portalUrl}`;
  const signoff = `Cordialement,\nL'équipe Renosud`;

  const body = `${greeting}\n\n${intro}\n\n${itemLines}\n\n${portalNote}\n\n${signoff}\n`;

  const existing = await storage.getProjectCommunicationByDedupeKey(opts.dedupeKey);
  if (existing) {
    // Only treat as a true no-op if the bundle actually went out. If a prior
    // attempt is still queued/draft/failed, reuse the same row so the caller
    // can re-attempt the Gmail send. Caller is responsible for rewriting
    // body/subject if the portal URL has changed since the original queue.
    return {
      communicationId: existing.id,
      alreadySent: existing.status === "sent",
      refreshedSubject: subject,
      refreshedBody: body,
    };
  }

  const created = await storage.createProjectCommunication({
    projectId: project.id,
    type: "devis_check_bundle",
    recipientType: "contractor",
    recipientEmail: contractor.email || "",
    recipientName: contractor.name,
    subject,
    body,
    status: "queued",
    dedupeKey: opts.dedupeKey,
  });

  return {
    communicationId: created.id,
    alreadySent: false,
    refreshedSubject: subject,
    refreshedBody: body,
  };
}

/**
 * Task #269 — subject of the client-context email sent alongside an
 * Archisign signature request. Client-facing → English ("Devis" is a
 * preserved domain term). Exported for the English-copy regression guard.
 */
export function buildDevisContextEmailSubject(opts: {
  refLabel: string;
  projectName: string;
}): string {
  return `Devis ${opts.refLabel} — ${opts.projectName}: electronic signature to follow`;
}

/**
 * Task #257 — body of the contextual email ArchiTrak sends to the client
 * when a devis goes out for signature. Archisign renders the `subject` of
 * `/envelopes/create` in its signer email but silently drops the `body`
 * field, so the architect's written context would otherwise never reach
 * the client — ArchiTrak delivers it itself via the architect's Gmail.
 *
 * The architect's message is the primary content (the FE pre-fills a
 * complete template with greeting + devis references, so we don't add a
 * second greeting). A fixed bilingual (FR/EN) footer announces the
 * incoming Archisign signature-link email so the client knows to expect
 * — and trust — it.
 *
 * Exported for unit tests.
 */
export function buildDevisContextEmailBody(opts: {
  architectMessage: string;
  refLabel: string;
  projectName: string;
}): string {
  const note =
    `You will shortly receive a separate email from Archisign containing the secure ` +
    `link to electronically sign devis ${opts.refLabel} (project "${opts.projectName}").`;
  // Task #442 — the fixed payment warning sits OUTSIDE the architect's
  // text so it is server-guaranteed on every send, whatever they wrote.
  return `${opts.architectMessage.trim()}\n\n---\n\n${CLIENT_NO_PAYMENT_NOTICE}\n\n${note}\n`;
}

export interface DevisContextEmailResult {
  communicationId: number | null;
  status: "sent" | "failed" | "already_sent";
  error?: string;
}

/**
 * Task #257 — send the mandatory client-context email for a devis
 * signature request, logged in `project_communications` (type
 * `devis_signature_context`).
 *
 * NEVER throws — envelope send has already succeeded by the time this
 * runs, and an email failure must not roll it back. The caller surfaces
 * `status: "failed"` to the architect as a visible warning instead.
 *
 * Idempotent per (devis, envelope) via `dedupeKey`: the resume branch of
 * the send-to-signer route can re-run this freely — an already-sent
 * context email is not re-sent, while a previously failed one is retried
 * on the same communication row.
 *
 * Respects E2E_FAKE_GMAIL implicitly: `sendCommunication` goes through
 * `getUncachableGmailClient`, which returns the in-memory fake client in
 * dev when the flag is set.
 */
export async function sendDevisSignatureContextEmail(opts: {
  devisId: number;
  envelopeId: string;
  message: string;
}): Promise<DevisContextEmailResult> {
  try {
    const devis = await storage.getDevis(opts.devisId);
    if (!devis) throw new Error(`Devis ${opts.devisId} not found`);
    const project = await storage.getProject(devis.projectId);
    if (!project) throw new Error(`Project ${devis.projectId} not found`);

    const recipientEmail = (project.clientContactEmail ?? "").trim();
    const recipientName = (project.clientContactName ?? "").trim();
    if (!recipientEmail) {
      throw new Error("Client contact email missing on project");
    }

    const refLabel = devis.devisNumber || devis.devisCode;
    const subject = buildDevisContextEmailSubject({ refLabel, projectName: project.name });
    const body = buildDevisContextEmailBody({
      architectMessage: opts.message,
      refLabel,
      projectName: project.name,
    });

    const dedupeKey = `devis-signature-context:${opts.devisId}:${opts.envelopeId}`;
    const existing = await storage.getProjectCommunicationByDedupeKey(dedupeKey);
    let communicationId: number;
    if (existing) {
      if (existing.status === "sent") {
        return { communicationId: existing.id, status: "already_sent" };
      }
      communicationId = existing.id;
      // Tasks #442/#443 — legacy rows queued/failed before the explainer
      // attachment and payment notice became standard carry stale content.
      // Refresh subject/body from the current builders and merge in the
      // attachment key before the retry, so EVERY context email that
      // actually goes out carries both guarantees.
      const existingKeys = (existing.attachmentStorageKeys as string[] | null) ?? [];
      const patch: Record<string, unknown> = {};
      if (!existingKeys.includes(SIGNING_EXPLAINER_ATTACHMENT_KEY)) {
        patch.attachmentStorageKeys = [...existingKeys, SIGNING_EXPLAINER_ATTACHMENT_KEY];
      }
      if (existing.subject !== subject) patch.subject = subject;
      if (existing.body !== body) patch.body = body;
      if (Object.keys(patch).length > 0) {
        await storage.updateProjectCommunication(existing.id, patch);
      }
    } else {
      const created = await storage.createProjectCommunication({
        projectId: project.id,
        type: "devis_signature_context",
        recipientType: "client",
        recipientEmail,
        recipientName: recipientName || project.clientName,
        subject,
        body,
        // Task #443 — every signature-context email carries the standard
        // one-page explainer PDF ("How signing and payment works"), a
        // bundled static asset. Kept OUT of the Archisign signing package
        // by design: the explainer stays separate from the legal document.
        attachmentStorageKeys: [SIGNING_EXPLAINER_ATTACHMENT_KEY],
        status: "queued",
        dedupeKey,
      });
      communicationId = created.id;
    }

    await sendCommunication(communicationId);
    return { communicationId, status: "sent" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[EmailSender] Devis context email failed for devis ${opts.devisId} envelope ${opts.envelopeId}:`,
      message,
    );
    return { communicationId: null, status: "failed", error: message };
  }
}

/**
 * Task #269 — payment-chase reminder templates sent to the client.
 * Client-facing → English copy only. Falls back to the "first" template
 * for unknown reminder types (preserves historic behaviour). Exported
 * for the English-copy regression guard.
 */
export function buildPaymentChaseTemplate(
  reminderType: string,
  projectName: string,
): { subject: string; body: string } {
  const templates: Record<string, { subject: string; body: string }> = {
    first: {
      subject: `Payment Reminder - ${projectName}`,
      body: `Dear Client,\n\nThis is a friendly reminder regarding the outstanding payment for project "${projectName}".\n\nPlease arrange payment at your earliest convenience.\n\nKind regards,\nSAS Architects-France`,
    },
    second: {
      subject: `Second Payment Reminder - ${projectName}`,
      body: `Dear Client,\n\nWe are writing to follow up on our previous reminder regarding the outstanding payment for project "${projectName}".\n\nWe would appreciate if you could arrange payment promptly.\n\nKind regards,\nSAS Architects-France`,
    },
    final: {
      subject: `Final Payment Reminder - ${projectName}`,
      body: `Dear Client,\n\nThis is our final reminder regarding the outstanding payment for project "${projectName}".\n\nPlease arrange payment immediately to avoid further action.\n\nKind regards,\nSAS Architects-France`,
    },
    overdue: {
      subject: `OVERDUE: Payment Required - ${projectName}`,
      body: `Dear Client,\n\nThe payment for project "${projectName}" is now overdue.\n\nPlease contact us immediately to discuss payment arrangements.\n\nKind regards,\nSAS Architects-France`,
    },
  };
  return templates[reminderType] || templates.first;
}

export async function sendPaymentChase(reminderId: number): Promise<void> {
  const reminder = await storage.getPaymentReminder(reminderId);
  if (!reminder) throw new Error(`Reminder ${reminderId} not found`);

  if (reminder.status !== "scheduled") {
    throw new Error(`Reminder is ${reminder.status}, not scheduled`);
  }

  const project = await storage.getProject(reminder.projectId);
  if (!project) throw new Error(`Project not found`);

  const template = buildPaymentChaseTemplate(reminder.reminderType, project.name);

  const comm: InsertProjectCommunication = {
    projectId: project.id,
    type: "payment_chase",
    recipientType: reminder.recipientType,
    recipientEmail: reminder.recipientEmail,
    recipientName: project.clientName,
    subject: template.subject,
    body: template.body,
    status: "queued",
    relatedCertificatId: reminder.certificatId,
    relatedInvoiceId: reminder.invoiceId,
  };

  const created = await storage.createProjectCommunication(comm);

  try {
    await sendCommunication(created.id);
    await storage.updatePaymentReminder(reminderId, {
      status: "sent",
      sentAt: new Date(),
    });
  } catch (err) {
    console.error(`[EmailSender] Failed to send payment chase ${reminderId}:`, err);
    throw err;
  }
}
