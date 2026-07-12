/**
 * Pennylane outbound push queue + retry orchestrator (Task #214,
 * AT5/drive-uploads-style).
 *
 *   - enqueueHonorairesPush(feeEntryId): the only entry point UI
 *     callers use. Walks fee_entry → project, enqueues the parent
 *     `customer` push first, then the dependent `customer_invoice`
 *     push. Both rows are idempotent on (kind, doc_id).
 *
 *   - attemptPennylanePush(pushId): single attempt. Selects
 *     `customer` | `customer_invoice` | `email_send` by kind and
 *     drives the corresponding API + storage write-back.
 *
 *   - sweepPennylanePushes / startPennylanePushSweeper /
 *     stopPennylanePushSweeper: 60s sweeper for due rows; also
 *     reclaims `in_flight` rows whose lease window expired.
 *
 * The whole module short-circuits when the feature flag is off (or
 * the API key is missing) — enqueue silently no-ops so wire-in
 * callers don't have to know.
 *
 * Dry-run mode (PENNYLANE_DRY_RUN=true): every kind logs its
 * resolved external_id + payload to the console, marks the push
 * `succeeded` with `dry_run=true`, and writes a sentinel pennylane
 * id (`dry-run:<kind>:<docId>`) into the mirror columns so the
 * downstream chain (invoice → email) can fire end-to-end against the
 * dummy ids without ever touching the API.
 */

import { storage } from "../../storage";
import {
  isPennylaneConfigured,
  isPennylaneDryRun,
  isPennylanePushEnabled,
  isProjectWhitelisted,
  iteratePages,
  PennylaneApiError,
  pennylaneRequest,
} from "./client";
import {
  buildCustomerExternalId,
  buildInvoiceExternalId,
  mapFeeEntryToCustomerInvoice,
  mapProjectToCustomer,
} from "./mappers";
import {
  buildPennylaneInvoiceObjectName,
  getDocumentBuffer,
  uploadDocumentAtKey,
} from "../../storage/object-storage";
import { getUncachableGmailClient, isGmailConfigured } from "../../gmail/client";
import type { FeeEntry, PennylanePush, PennylanePushKind, Project } from "@shared/schema";

export const MAX_PENNYLANE_PUSH_ATTEMPTS = 5;

const BACKOFF_MS: readonly number[] = [
  10_000,   // after attempt 1 → 10s
  30_000,   // after attempt 2 → 30s
  120_000,  // after attempt 3 → 2m
  300_000,  // after attempt 4 → 5m
];

let sweeperInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Lease window for an `in_flight` claim. If a worker crashes between
 * claim and finish, the row would otherwise stick in `in_flight`
 * forever (sweeper only scans `pending`). 10 minutes is well above
 * any realistic API + PDF + email round-trip.
 */
export const STALE_IN_FLIGHT_RECLAIM_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------
// Enqueue entry points
// ---------------------------------------------------------------------

/**
 * One-click enqueue for "Invoice fees now" on Outstanding Fees.
 * Idempotent — re-enqueuing for a fee_entry that already has a
 * succeeded customer_invoice row is a no-op.
 *
 * Returns the customer_invoice push row that was enqueued (or the
 * existing one when this fee_entry was already in flight). Returns
 * `null` when the feature is disabled at this layer (flag off,
 * whitelist excludes the project, etc.) so the route handler can
 * return a meaningful 409 instead of silently no-opping.
 */
export async function enqueueHonorairesPush(
  feeEntryId: number,
): Promise<PennylanePush | null> {
  if (!isPennylanePushEnabled()) return null;

  const feeEntry = await loadFeeEntry(feeEntryId);
  if (!feeEntry) throw new Error(`fee_entry ${feeEntryId} not found`);

  const fee = await storage.getFee(feeEntry.feeId);
  if (!fee) throw new Error(`fee ${feeEntry.feeId} not found`);
  const project = await storage.getProject(fee.projectId);
  if (!project) throw new Error(`project ${fee.projectId} not found`);

  if (!isProjectWhitelisted(project.id)) {
    console.warn(
      `[PennylaneQueue] enqueue blocked — project ${project.id} not in whitelist`,
    );
    return null;
  }

  // Parent: customer (idempotent on (customer, projectId))
  await storage.upsertPennylanePush({
    kind: "customer",
    docId: project.id,
    projectId: project.id,
    state: "pending",
    attempts: 0,
    nextAttemptAt: new Date(),
  });

  // Child: customer_invoice (idempotent on (customer_invoice, feeEntryId))
  const invoiceRow = await storage.upsertPennylanePush({
    kind: "customer_invoice",
    docId: feeEntry.id,
    projectId: project.id,
    state: "pending",
    attempts: 0,
    nextAttemptAt: new Date(),
  });

  // Fire-and-forget inline attempt so the operator sees state move
  // within seconds of clicking. The sweeper picks up anything that
  // stays pending. We deliberately do NOT await — attempt errors are
  // logged + written back to the row.
  void scheduleInlineSweep(project.id);

  return invoiceRow;
}

/**
 * Internal: trigger one immediate sweep of due rows for a project.
 * Walks customer → invoice → email order via standard sweep semantics
 * (each attempt enqueues the next kind on success).
 */
async function scheduleInlineSweep(projectId: number): Promise<void> {
  try {
    const due = await storage.listDuePennylanePushes(10);
    for (const row of due.filter((r) => r.projectId === projectId)) {
      attemptPennylanePush(row.id).catch((err) => {
        console.error(`[PennylaneQueue] inline attempt for push ${row.id} crashed:`, err);
      });
    }
  } catch (err) {
    console.error("[PennylaneQueue] inline sweep failed:", err);
  }
}

// ---------------------------------------------------------------------
// Single-attempt worker
// ---------------------------------------------------------------------

export async function attemptPennylanePush(pushId: number): Promise<void> {
  if (!isPennylanePushEnabled()) return;

  const claimed = await storage.claimPennylanePushForAttempt(pushId);
  if (!claimed) return; // someone else grabbed it or it's already terminal

  const row = claimed;
  const attemptNum = row.attempts + 1;
  try {
    const kind = row.kind as PennylanePushKind;
    let pennylaneId: string | null = null;
    let outcome: "success" | "retry" = "success";
    let retryReason: string | null = null;

    switch (kind) {
      case "customer": {
        const result = await runCustomerPush(row);
        pennylaneId = result.pennylaneId;
        break;
      }
      case "customer_invoice": {
        const result = await runCustomerInvoicePush(row);
        if (result.kind === "retry") {
          outcome = "retry";
          retryReason = result.reason;
        } else {
          pennylaneId = result.pennylaneId;
        }
        break;
      }
      case "email_send": {
        const result = await runEmailSendPush(row);
        if (result.kind === "retry") {
          outcome = "retry";
          retryReason = result.reason;
        } else {
          pennylaneId = result.gmailMessageId;
        }
        break;
      }
      default: {
        // Compile-time exhaustiveness — adding a kind forces a handler.
        const _never: never = kind;
        throw new Error(`Unknown pennylane push kind: ${String(_never)}`);
      }
    }

    if (outcome === "retry") {
      // Soft retry — precondition not met (e.g. customer not yet
      // created). Burn an attempt and back off; this is identical to
      // a transient API failure from the queue's perspective.
      await schedulePendingRetry(row, attemptNum, retryReason ?? "precondition not met");
      return;
    }

    await storage.markPennylanePushSucceeded({
      pushId: row.id,
      attempts: attemptNum,
      pennylaneId,
      dryRun: isPennylaneDryRun(),
    });
  } catch (err) {
    const transient =
      err instanceof PennylaneApiError ? err.transient : false;
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = attemptNum >= MAX_PENNYLANE_PUSH_ATTEMPTS;
    if (!transient || exhausted) {
      await storage.markPennylanePushDeadLettered({
        pushId: row.id,
        attempts: attemptNum,
        lastError: message.slice(0, 1000),
      });
      console.warn(
        `[PennylaneQueue] push ${row.id} (${row.kind}#${row.docId}) ${exhausted ? "exhausted" : "permanent failure"}: ${message}`,
      );
      return;
    }
    await schedulePendingRetry(row, attemptNum, message);
  }
}

async function schedulePendingRetry(
  row: PennylanePush,
  attemptNum: number,
  reason: string,
): Promise<void> {
  const wait = BACKOFF_MS[Math.min(attemptNum - 1, BACKOFF_MS.length - 1)];
  await storage.markPennylanePushPendingRetry({
    pushId: row.id,
    attempts: attemptNum,
    lastError: reason.slice(0, 1000),
    nextAttemptAt: new Date(Date.now() + wait),
  });
  console.warn(
    `[PennylaneQueue] push ${row.id} (${row.kind}#${row.docId}) retry ${attemptNum} in ${Math.round(wait / 1000)}s: ${reason}`,
  );
}

// ---------------------------------------------------------------------
// Per-kind handlers
// ---------------------------------------------------------------------

interface PennylaneCustomerResponse {
  id?: number | string;
  customer?: { id?: number | string };
  external_id?: string;
}

async function runCustomerPush(row: PennylanePush): Promise<{ pennylaneId: string }> {
  const project = await storage.getProject(row.docId);
  if (!project) throw new Error(`project ${row.docId} not found`);

  // Short-circuit if the project already has a customer id (idempotency
  // recovery — a previous attempt may have created the customer in
  // Pennylane but failed to write our mirror column before crashing).
  if (project.pennylaneCustomerId) {
    return { pennylaneId: project.pennylaneCustomerId };
  }

  const payload = mapProjectToCustomer(project);

  if (isPennylaneDryRun()) {
    const dryId = `dry-run:customer:${project.id}`;
    console.log(
      `[PennylaneQueue] DRY-RUN customer push for project ${project.id}: ${JSON.stringify(payload)}`,
    );
    await storage.setProjectPennylaneCustomerId(project.id, dryId);
    return { pennylaneId: dryId };
  }

  // Try to find an existing customer by external_id first — recovers
  // from the case where a previous POST succeeded but the response was
  // lost in transit. The v2 API supports a filter on external_id via
  // /customers?external_id=…
  const existingId = await findCustomerByExternalId(payload.external_id);
  let customerId: string;
  if (existingId) {
    customerId = existingId;
  } else {
    const created = await pennylaneRequest<PennylaneCustomerResponse>({
      method: "POST",
      path: "/customers",
      body: payload,
    });
    customerId = extractCustomerId(created);
  }
  await storage.setProjectPennylaneCustomerId(project.id, customerId);
  return { pennylaneId: customerId };
}

function extractCustomerId(res: PennylaneCustomerResponse): string {
  const raw = res.customer?.id ?? res.id;
  if (raw === undefined || raw === null) {
    throw new Error("Pennylane customer response missing id");
  }
  return String(raw);
}

async function findCustomerByExternalId(externalId: string): Promise<string | null> {
  try {
    for await (const page of iteratePages<PennylaneCustomerResponse>(
      "/customers",
      { external_id: externalId, per_page: 1 },
    )) {
      for (const item of page) {
        if (item.external_id === externalId) {
          return extractCustomerId(item);
        }
      }
      // Only inspect the first page — external_id is a high-cardinality
      // filter so anything beyond page 1 is a paginator quirk.
      break;
    }
  } catch (err) {
    // Don't fail the push just because the lookup failed — the create
    // will surface a 409 / duplicate from the API itself, which the
    // outer retry logic handles cleanly.
    console.warn(
      `[PennylaneQueue] external_id lookup failed for ${externalId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

interface PennylaneInvoiceResponse {
  id?: number | string;
  invoice?: { id?: number | string; public_file_url?: string; status?: string };
  public_file_url?: string;
  status?: string;
  external_id?: string;
}

/**
 * Mirror of findCustomerByExternalId for customer_invoices — recovers
 * from the crash-window where a POST /customer_invoices succeeded
 * remotely but our mirror-write or response was lost. Without this
 * step, a retry would either create a duplicate invoice or dead-letter
 * on the API's 409. Used both as a pre-create probe AND as a 409
 * recovery path inside runCustomerInvoicePush.
 */
async function findInvoiceByExternalId(
  externalId: string,
): Promise<{ id: string; status: string | null; publicUrl: string | null } | null> {
  try {
    for await (const page of iteratePages<PennylaneInvoiceResponse>(
      "/customer_invoices",
      { external_id: externalId, per_page: 1 },
    )) {
      for (const item of page) {
        if (item.external_id === externalId) {
          const id = extractInvoiceId(item);
          const status = item.invoice?.status ?? item.status ?? null;
          const publicUrl = item.invoice?.public_file_url ?? item.public_file_url ?? null;
          return { id, status, publicUrl };
        }
      }
      break;
    }
  } catch (err) {
    console.warn(
      `[PennylaneQueue] invoice external_id lookup failed for ${externalId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

type HandlerResult<T> =
  | ({ kind: "ok" } & T)
  | { kind: "retry"; reason: string };

async function runCustomerInvoicePush(
  row: PennylanePush,
): Promise<HandlerResult<{ pennylaneId: string }>> {
  const feeEntry = await loadFeeEntry(row.docId);
  if (!feeEntry) throw new Error(`fee_entry ${row.docId} not found`);

  // Recovery short-circuit — if the row already has an invoice id we
  // never re-create. Treat the mirror PDF + email chain as the
  // continuation point.
  if (feeEntry.pennylaneInvoiceId) {
    await enqueueEmailSend(row.projectId, feeEntry.id);
    return { kind: "ok", pennylaneId: feeEntry.pennylaneInvoiceId };
  }

  const fee = await storage.getFee(feeEntry.feeId);
  if (!fee) throw new Error(`fee ${feeEntry.feeId} not found`);
  const project = await storage.getProject(fee.projectId);
  if (!project) throw new Error(`project ${fee.projectId} not found`);

  if (!project.pennylaneCustomerId) {
    // Customer push hasn't landed yet — soft retry. The customer
    // push row is already enqueued (enqueueHonorairesPush queues
    // both); the sweeper will pick it up before this one's next
    // attempt.
    return { kind: "retry", reason: "awaiting parent customer push" };
  }

  const payload = mapFeeEntryToCustomerInvoice(feeEntry, {
    pennylaneCustomerId: project.pennylaneCustomerId,
    label: buildInvoiceLabel(project),
    reference: `${project.code} / FE#${feeEntry.id}`,
    description: feeEntry.devisId ? `Honoraires liés au devis #${feeEntry.devisId}` : undefined,
    issueDate: new Date(),
    paymentTermsDays: 30,
  });

  if (isPennylaneDryRun()) {
    const dryId = `dry-run:invoice:${feeEntry.id}`;
    console.log(
      `[PennylaneQueue] DRY-RUN customer_invoice push for fee_entry ${feeEntry.id}: ${JSON.stringify(payload)}`,
    );
    await storage.setFeeEntryPennylaneInvoice({
      feeEntryId: feeEntry.id,
      pennylaneInvoiceId: dryId,
      pennylanePdfStorageKey: null,
      pennylaneStatus: "dry_run",
    });
    await enqueueEmailSend(project.id, feeEntry.id);
    return { kind: "ok", pennylaneId: dryId };
  }

  // Pre-create idempotency probe by external_id. Pennylane's create
  // endpoint is NOT idempotent on external_id collisions, so we look
  // first and fall back to recovery on 409 below.
  const preExisting = await findInvoiceByExternalId(payload.external_id);

  let invoiceId: string;
  let status: string | null;
  let publicUrl: string | null;

  if (preExisting) {
    invoiceId = preExisting.id;
    status = preExisting.status;
    publicUrl = preExisting.publicUrl;
  } else {
    let created: PennylaneInvoiceResponse;
    try {
      created = await pennylaneRequest<PennylaneInvoiceResponse>({
        method: "POST",
        path: "/customer_invoices",
        body: payload,
      });
    } catch (err) {
      // Race recovery: another worker (or a crashed prior attempt that
      // succeeded remotely after our pre-probe) created the invoice
      // between our lookup and the POST. Pennylane responds 409/422
      // for duplicate external_id — re-resolve and continue.
      if (
        err instanceof PennylaneApiError &&
        (err.status === 409 || err.status === 422)
      ) {
        const recovered = await findInvoiceByExternalId(payload.external_id);
        if (!recovered) throw err;
        invoiceId = recovered.id;
        status = recovered.status;
        publicUrl = recovered.publicUrl;
        console.warn(
          `[PennylaneQueue] recovered from duplicate-create (status=${err.status}) for fee_entry ${feeEntry.id} → invoice ${invoiceId}`,
        );
        // jump past the assignment block by reusing the persistence path below
        await persistInvoiceMirror({ project, feeEntry, invoiceId, status, publicUrl });
        await enqueueEmailSend(project.id, feeEntry.id);
        return { kind: "ok", pennylaneId: invoiceId };
      }
      throw err;
    }
    invoiceId = extractInvoiceId(created);
    status = created.invoice?.status ?? created.status ?? null;
    publicUrl = created.invoice?.public_file_url ?? created.public_file_url ?? null;
  }

  await persistInvoiceMirror({ project, feeEntry, invoiceId, status, publicUrl });
  await enqueueEmailSend(project.id, feeEntry.id);
  return { kind: "ok", pennylaneId: invoiceId };
}

async function persistInvoiceMirror(args: {
  project: { id: number };
  feeEntry: { id: number };
  invoiceId: string;
  status: string | null;
  publicUrl: string | null;
}): Promise<void> {
  let storageKey: string | null = null;
  if (args.publicUrl) {
    try {
      storageKey = await mirrorInvoicePdf({
        projectId: args.project.id,
        feeEntryId: args.feeEntry.id,
        publicUrl: args.publicUrl,
      });
    } catch (err) {
      // Mirror failure is recoverable — the invoice exists on
      // Pennylane already. Log + continue; the email-send step will
      // re-attempt the mirror via a refreshed public_file_url.
      console.warn(
        `[PennylaneQueue] PDF mirror failed for fee_entry ${args.feeEntry.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await storage.setFeeEntryPennylaneInvoice({
    feeEntryId: args.feeEntry.id,
    pennylaneInvoiceId: args.invoiceId,
    pennylanePdfStorageKey: storageKey,
    pennylaneStatus: args.status,
  });
}

function extractInvoiceId(res: PennylaneInvoiceResponse): string {
  const raw = res.invoice?.id ?? res.id;
  if (raw === undefined || raw === null) {
    throw new Error("Pennylane invoice response missing id");
  }
  return String(raw);
}

function buildInvoiceLabel(project: Project): string {
  return `Honoraires d'architecte — ${project.name}`;
}

async function enqueueEmailSend(projectId: number, feeEntryId: number): Promise<void> {
  await storage.upsertPennylanePush({
    kind: "email_send",
    docId: feeEntryId,
    projectId,
    state: "pending",
    attempts: 0,
    nextAttemptAt: new Date(),
  });
}

async function mirrorInvoicePdf(args: {
  projectId: number;
  feeEntryId: number;
  publicUrl: string;
}): Promise<string> {
  const res = await fetch(args.publicUrl);
  if (!res.ok) {
    throw new Error(`PDF download failed: HTTP ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  const objectName = buildPennylaneInvoiceObjectName(args.projectId, args.feeEntryId);
  return uploadDocumentAtKey(objectName, buffer, "application/pdf");
}

// ---------------------------------------------------------------------
// Email-send handler — chained after a successful customer_invoice push.
// ---------------------------------------------------------------------

async function runEmailSendPush(
  row: PennylanePush,
): Promise<HandlerResult<{ gmailMessageId: string }>> {
  const feeEntry = await loadFeeEntry(row.docId);
  if (!feeEntry) throw new Error(`fee_entry ${row.docId} not found`);
  if (!feeEntry.pennylaneInvoiceId) {
    return { kind: "retry", reason: "awaiting customer_invoice push" };
  }

  const fee = await storage.getFee(feeEntry.feeId);
  if (!fee) throw new Error(`fee ${feeEntry.feeId} not found`);
  const project = await storage.getProject(fee.projectId);
  if (!project) throw new Error(`project ${fee.projectId} not found`);

  const recipient = project.clientContactEmail;
  if (!recipient) {
    // No recipient ever configured for the project. Permanent failure
    // — throw a non-PennylaneApiError so the worker doesn't classify
    // it as transient.
    throw new Error(
      `Project ${project.id} has no clientContactEmail — cannot send invoice email`,
    );
  }

  if (isPennylaneDryRun()) {
    const dryId = `dry-run:email:${feeEntry.id}`;
    console.log(
      `[PennylaneQueue] DRY-RUN email_send to ${recipient} for fee_entry ${feeEntry.id} (invoice ${feeEntry.pennylaneInvoiceId})`,
    );
    return { kind: "ok", gmailMessageId: dryId };
  }

  if (!isGmailConfigured()) {
    return { kind: "retry", reason: "gmail not configured" };
  }

  // Refresh the public_file_url + remirror if we lost the PDF earlier.
  let pdfBuffer: Buffer;
  if (feeEntry.pennylanePdfStorageKey) {
    pdfBuffer = await getDocumentBuffer(feeEntry.pennylanePdfStorageKey);
  } else {
    const refreshed = await refreshPublicFileUrl(feeEntry.pennylaneInvoiceId);
    if (!refreshed) {
      return { kind: "retry", reason: "no public_file_url available yet" };
    }
    const storageKey = await mirrorInvoicePdf({
      projectId: project.id,
      feeEntryId: feeEntry.id,
      publicUrl: refreshed,
    });
    await storage.setFeeEntryPennylaneInvoice({
      feeEntryId: feeEntry.id,
      pennylaneInvoiceId: feeEntry.pennylaneInvoiceId,
      pennylanePdfStorageKey: storageKey,
      pennylaneStatus: feeEntry.pennylaneStatus,
    });
    pdfBuffer = await getDocumentBuffer(storageKey);
  }

  const subject = `Architect fee invoice (Honoraires) — ${project.name} (${project.code})`;
  const body = buildClientEmailBody(project, feeEntry);
  const filename = `Honoraires-${project.code}-FE${feeEntry.id}.pdf`;

  const gmailMessageId = await sendInvoiceEmail({
    recipient,
    subject,
    body,
    pdfBuffer,
    pdfFilename: filename,
  });
  return { kind: "ok", gmailMessageId };
}

export function buildClientEmailBody(project: Project, feeEntry: FeeEntry): string {
  const greeting = project.clientContactName ? `Dear ${project.clientContactName},` : "Dear Client,";
  const amount = Number(feeEntry.feeAmount).toFixed(2);
  return [
    greeting,
    "",
    `Please find attached the architect's fee invoice (Honoraires) for project "${project.name}" (${project.code}).`,
    "",
    `Amount: ${amount} € HT`,
    "",
    "You can settle this invoice by bank transfer using the details shown on the document.",
    "",
    "If you have any questions, please feel free to reply to this email.",
    "",
    "Kind regards,",
  ].join("\r\n");
}

interface SendInvoiceEmailArgs {
  recipient: string;
  subject: string;
  body: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
}

async function sendInvoiceEmail(args: SendInvoiceEmailArgs): Promise<string> {
  const gmail = await getUncachableGmailClient();
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const lines: string[] = [
    `From: me`,
    `To: ${args.recipient}`,
    `Subject: ${args.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    args.body,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${args.pdfFilename}"`,
    `Content-Disposition: attachment; filename="${args.pdfFilename}"`,
    `Content-Transfer-Encoding: base64`,
    "",
    args.pdfBuffer.toString("base64"),
    `--${boundary}--`,
  ];
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  const id = res.data.id;
  if (!id) throw new Error("Gmail send returned no message id");
  return id;
}

async function refreshPublicFileUrl(invoiceId: string): Promise<string | null> {
  try {
    const inv = await pennylaneRequest<PennylaneInvoiceResponse>({
      method: "GET",
      path: `/customer_invoices/${invoiceId}`,
    });
    return inv.invoice?.public_file_url ?? inv.public_file_url ?? null;
  } catch (err) {
    console.warn(
      `[PennylaneQueue] refresh public_file_url failed for ${invoiceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------

export async function sweepPennylanePushes(): Promise<void> {
  if (!isPennylanePushEnabled()) return;
  try {
    const reclaimed = await storage.reclaimStalePennylanePushes(STALE_IN_FLIGHT_RECLAIM_MS);
    if (reclaimed > 0) {
      console.warn(`[PennylaneQueue] reclaimed ${reclaimed} stale in_flight push(es)`);
    }
    const due = await storage.listDuePennylanePushes(20);
    for (const row of due) {
      await attemptPennylanePush(row.id).catch((err) => {
        console.error(`[PennylaneQueue] sweep attempt for ${row.id} crashed:`, err);
      });
    }
  } catch (err) {
    console.error("[PennylaneQueue] sweep failed:", err);
  }
}

export function startPennylanePushSweeper(intervalMs: number = 60_000): void {
  if (sweeperInterval) return;
  if (!isPennylanePushEnabled()) {
    console.log("[PennylaneQueue] sweeper not started — feature disabled");
    return;
  }
  sweeperInterval = setInterval(() => {
    sweepPennylanePushes().catch(console.error);
  }, intervalMs);
  console.log(`[PennylaneQueue] sweeper started (every ${Math.round(intervalMs / 1000)}s)`);
}

export function stopPennylanePushSweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function loadFeeEntry(feeEntryId: number): Promise<FeeEntry | null> {
  const entry = await storage.getFeeEntry(feeEntryId);
  return entry ?? null;
}

// Re-export env-derived helpers for callers that want to gate UI on
// the same predicates the worker uses.
export {
  isPennylaneConfigured,
  isPennylanePushEnabled,
  isPennylaneDryRun,
} from "./client";

