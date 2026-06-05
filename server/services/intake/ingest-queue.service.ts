/**
 * Background ingest & auto-routing pipeline (Task #230).
 *
 * Every project intake document (manual upload or Gmail-mirrored) gets
 * exactly one queue row (`intake_jobs`). A process-local sweeper claims
 * `pending` rows (lease → `in_flight`), runs the pipeline, and either
 * succeeds, retries with exponential backoff, or dead-letters after
 * MAX_INTAKE_ATTEMPTS — mirroring the proven drive_uploads /
 * pennylane_pushes machinery so we don't invent a new pattern.
 *
 * Pipeline (inside `attemptIntakeJob`):
 *   1. fetch bytes from object storage
 *   2. dedup by exact-bytes fingerprint (sha256) against already-analysed
 *      docs in the SAME project — duplicate ⇒ park as `duplicate`
 *   3. PDF magic-byte guard — non-PDF ⇒ park
 *   4. Gemini classify/extract (parseDocument, run ONCE)
 *   5. dedup by normalised-text hash (catches re-exports) ⇒ `duplicate`
 *   6. route by documentType:
 *        - quotation        → processDevisUpload  (typed devis DRAFT)
 *        - invoice/acompte  → unique devis match → processInvoiceUpload
 *        - everything else  → park (manual routing — later task)
 *
 * The pipeline NEVER moves money: it only ever creates DRAFT records via
 * the existing upload services (which themselves persist drafts only).
 *
 * The user-facing analysis/routing state lives on the intake document
 * row (`project_intake_documents.analysisState` / `.routingState`); the
 * queue row carries only retry bookkeeping for the admin DLQ.
 */

import crypto from "crypto";
import { storage } from "../../storage";
import { getDocumentBuffer } from "../../storage/object-storage";
import { assertPdfMagic } from "../../middleware/upload";
import { processDevisUpload } from "../devis-upload.service";
import { processInvoiceUpload } from "../invoice-upload.service";
import type { ParsedDocument } from "../../gmail/document-parser";
import type { ProjectIntakeDocument } from "@shared/schema";

export const MAX_INTAKE_ATTEMPTS = 5;

// Backoff schedule between attempts (ms). Index = attempt number that
// just failed (1..4). Mirrors the drive_uploads / pennylane schedule.
const BACKOFF_MS: readonly number[] = [
  10_000, // after attempt 1 → 10s
  30_000, // after attempt 2 → 30s
  120_000, // after attempt 3 → 2m
  300_000, // after attempt 4 → 5m
];

/**
 * Lease window for an `in_flight` claim. A worker that crashes between
 * claim and finish would otherwise wedge the row in `in_flight` forever
 * (the sweeper only scans `pending`). Reclaim any in_flight row whose
 * `lastAttemptAt` is older than this. 10 min is well above any realistic
 * parse time (Gemini round-trip on a <25 MiB PDF).
 */
export const STALE_IN_FLIGHT_RECLAIM_MS = 10 * 60 * 1000;

let sweeperInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Marker error: the attempt failed for a reason that may succeed on a
 * later try (Gemini 503, object-storage blip). Thrown to drive the
 * backoff/retry path. Anything else thrown is treated the same way
 * (defensive) but parking is preferred for known-permanent outcomes.
 */
class TransientIntakeError extends Error {}

/**
 * Idempotent enqueue — the only entry point callers use. Safe to call
 * from any wire-in point; the SQL UNIQUE on (intake_document_id) means
 * re-enqueuing an existing row is a no-op. The first attempt is fired
 * inline (fire-and-forget) so a manual upload routes within seconds in
 * the happy path; transient failures self-heal via the sweeper.
 */
export async function enqueueIntakeJob(intakeDocumentId: number): Promise<void> {
  try {
    const row = await storage.upsertIntakeJob(intakeDocumentId);
    if (row.state === "pending" && row.attempts === 0) {
      attemptIntakeJob(row.id).catch((err) => {
        console.error(`[IntakeQueue] inline first attempt for job ${row.id} crashed:`, err);
      });
    }
  } catch (err) {
    console.error(`[IntakeQueue] enqueue failed for intake doc #${intakeDocumentId}:`, err);
  }
}

function norm(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim().toLowerCase();
  return cleaned.length ? cleaned : null;
}

/**
 * Canonical content hash of a *successful* extraction. The previous
 * implementation hashed `parsed.rawText`, but the Gemini success schema
 * never populates that field (it's only set on parse-failure paths), so
 * text-hash dedup was effectively dead. Instead we hash the stable,
 * salient extracted fields — this catches the same logical document
 * re-exported with different bytes (different PDF producer, re-saved,
 * re-scanned at a different resolution).
 *
 * Returns null when the extraction carries no real signal, so we never
 * dedup on garbage (two unparseable docs must not collapse into one).
 */
function computeContentHash(parsed: ParsedDocument): string | null {
  const hasSignal =
    parsed.documentType !== "unknown" &&
    (parsed.amountHt != null ||
      parsed.amountTtc != null ||
      !!parsed.contractorName ||
      (parsed.lineItems?.length ?? 0) > 0);
  if (!hasSignal) return null;

  const canonical = JSON.stringify({
    type: parsed.documentType,
    contractor: norm(parsed.contractorName),
    devisNumber: norm(parsed.devisNumber),
    invoiceNumber: norm(parsed.invoiceNumber),
    reference: norm(parsed.reference),
    siret: parsed.siret ? parsed.siret.replace(/\D/g, "") || null : null,
    amountHt: parsed.amountHt ?? null,
    amountTtc: parsed.amountTtc ?? null,
    date: norm(parsed.date),
    lines: (parsed.lineItems ?? []).map((li) => [
      norm(li.description),
      li.quantity ?? null,
      li.unitPrice ?? null,
      li.total ?? null,
    ]),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Per-project serialization lock. The dedup checks
 * (`findProcessedIntakeDuplicate*`) only match rows that are already
 * `analyzed`, so two identical documents processed concurrently could
 * BOTH miss dedup and BOTH create a draft. Each intake document is a
 * separate queue job, so the per-job claim lock doesn't protect against
 * this cross-job race. We serialize the dedup→route critical section per
 * project: within a project, documents are processed one at a time, so a
 * later doc always sees the earlier one's committed `analyzed` state.
 * Cross-project work still runs in parallel.
 *
 * This is a single-process, in-memory lock — sufficient because the
 * sweeper and inline attempts all run in this one Node process (same
 * model as the drive_uploads / pennylane sweepers). A multi-instance
 * deployment would need a DB-level guard instead.
 */
const projectChains = new Map<number, Promise<void>>();
function withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
  const prev = projectChains.get(projectId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Keep the chain alive but never let it reject, so the next waiter
  // always resumes regardless of this attempt's outcome.
  projectChains.set(
    projectId,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/**
 * Best-effort single attempt. Claims the row, runs the pipeline, and
 * updates BOTH the queue row and the owning intake document state in
 * place. Safe to call concurrently — the claim UPDATE is the lock.
 */
export async function attemptIntakeJob(jobId: number): Promise<void> {
  const claimed = await storage.claimIntakeJobForAttempt(jobId);
  if (!claimed) return; // someone else grabbed it / already terminal

  const row = claimed;
  const attemptNum = row.attempts + 1;
  try {
    await runPipeline(row.intakeDocumentId);
    await storage.markIntakeJobSucceeded({ jobId: row.id, attempts: attemptNum });
  } catch (err) {
    const transient = err instanceof TransientIntakeError;
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = attemptNum >= MAX_INTAKE_ATTEMPTS;
    if (!transient || exhausted) {
      // Permanent failure (or retries exhausted): dead-letter the queue
      // row AND mark the intake document analysis as failed so the user
      // sees a terminal state instead of a perpetual "analyzing".
      await storage.markIntakeJobDeadLettered({
        jobId: row.id,
        attempts: attemptNum,
        lastError: message.slice(0, 1000),
      });
      await storage
        .updateProjectIntakeDocument(row.intakeDocumentId, { analysisState: "failed", routingState: "failed" })
        .catch((e) => console.error(`[IntakeQueue] failed to mark doc #${row.intakeDocumentId} failed:`, e));
      console.warn(
        `[IntakeQueue] job ${row.id} (intake #${row.intakeDocumentId}) ${exhausted ? "exhausted" : "permanent failure"}: ${message}`,
      );
      return;
    }
    const wait = BACKOFF_MS[Math.min(attemptNum - 1, BACKOFF_MS.length - 1)];
    await storage.markIntakeJobPendingRetry({
      jobId: row.id,
      attempts: attemptNum,
      lastError: message.slice(0, 1000),
      nextAttemptAt: new Date(Date.now() + wait),
    });
    console.warn(
      `[IntakeQueue] job ${row.id} transient failure on attempt ${attemptNum}, retry in ${Math.round(wait / 1000)}s: ${message}`,
    );
  }
}

/**
 * The actual ingest + routing logic. Throws TransientIntakeError to
 * request a retry; throws anything else (or returns) for terminal
 * outcomes. Writes the intake document's analysis/routing state as it
 * progresses so the UI reflects live status.
 */
async function runPipeline(intakeDocumentId: number): Promise<void> {
  const doc = await storage.getProjectIntakeDocument(intakeDocumentId);
  if (!doc) {
    // The owning doc vanished (cascade delete). Nothing to do — treat as
    // a clean success so the queue row terminates rather than retrying.
    return;
  }

  await storage.updateProjectIntakeDocument(doc.id, { analysisState: "analyzing" });

  // 1. Fetch bytes. A missing object is transient-ish (eventual
  //    consistency right after upload) for the first few tries.
  let buffer: Buffer;
  try {
    buffer = await getDocumentBuffer(doc.storageKey);
  } catch (err) {
    throw new TransientIntakeError(
      `object-storage fetch failed for ${doc.storageKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Exact-bytes fingerprint (cheap, no shared state) — computed outside
  // the lock; the dedup *check* against it happens inside.
  const fingerprint = crypto.createHash("sha256").update(buffer).digest("hex");

  // Steps 2–6 run under a per-project lock so two identical documents
  // can't both miss dedup and both create a draft (see withProjectLock).
  await withProjectLock(doc.projectId, async () => {
    // 2. Exact-bytes dedup against already-analysed docs in this project.
    const byteDup = await storage.findProcessedIntakeDuplicateByFingerprint(doc.projectId, fingerprint, doc.id);
    if (byteDup) {
      await markDuplicate(doc, fingerprint, byteDup.id, null);
      return;
    }

    // 3. PDF guard — anything that isn't a real PDF can't be parsed/routed.
    try {
      assertPdfMagic(buffer);
    } catch {
      await storage.updateProjectIntakeDocument(doc.id, {
        contentFingerprint: fingerprint,
        analysisState: "analyzed",
        routingState: "parked",
        notes: appendNote(doc.notes, "Parked: not a PDF (magic-byte check failed)."),
      });
      return;
    }

    // 4. Classify + extract ONCE. The result is handed down to the upload
    //    services so Gemini is never called twice for the same bytes.
    const { parseDocument, matchToProject, isTransientParseFailure, getParseFailureMessage } = await import(
      "../../gmail/document-parser"
    );
    const parsed: ParsedDocument = await parseDocument(buffer, doc.fileName);

    // A total extraction whiff: if the parser produced nothing usable AND
    // signals a transient backend failure, retry; otherwise it's a real
    // unparseable doc → park.
    const noSignal =
      parsed.documentType === "unknown" && !parsed.amountHt && !parsed.contractorName && !parsed.lineItems?.length;
    if (noSignal && isTransientParseFailure(parsed)) {
      throw new TransientIntakeError(
        `AI extraction transiently unavailable: ${getParseFailureMessage(parsed) ?? "unknown"}`,
      );
    }

    // 5. Near-duplicate dedup by canonical extracted-content hash (same
    //    logical doc re-exported with different bytes).
    const contentHash = computeContentHash(parsed);
    if (contentHash) {
      const contentDup = await storage.findProcessedIntakeDuplicateByTextHash(doc.projectId, contentHash, doc.id);
      if (contentDup) {
        await markDuplicate(doc, fingerprint, contentDup.id, contentHash);
        return;
      }
    }

    // Persist provenance (fingerprint + extraction + content hash) before
    // routing so a crash mid-route still leaves an auditable record.
    const extractedData = { ...parsed, contentHash };
    await storage.updateProjectIntakeDocument(doc.id, {
      contentFingerprint: fingerprint,
      extractedData,
    });

    const file = {
      originalname: doc.fileName,
      buffer,
      mimetype: doc.mimeType ?? "application/pdf",
    };

    // 6. Route by documentType.
    switch (parsed.documentType) {
      case "quotation": {
        const result = await processDevisUpload(doc.projectId, file, parsed);
        if (result.success) {
          const devisId = (result.data as { devis: { id: number } }).devis.id;
          await storage.updateProjectIntakeDocument(doc.id, {
            analysisState: "analyzed",
            routingState: "routed",
            promotedKind: "devis",
            promotedId: devisId,
          });
          return;
        }
        // 503 = transient AI failure → retry. Anything else (422 contractor
        // not found, no contractors synced, parse failed) is a real reason
        // to park for manual handling.
        if (result.status === 503) {
          throw new TransientIntakeError(
            `devis routing transient: ${(result.data as { message?: string }).message ?? "unknown"}`,
          );
        }
        await park(doc, fingerprint, `Devis routing failed: ${(result.data as { message?: string }).message ?? "unknown"}`);
        return;
      }
      case "invoice":
      case "acompte": {
        // An invoice can only be auto-routed when it maps to exactly ONE
        // devis (project + contractor). Zero or many ⇒ park for manual
        // attach — auto-guessing would risk filing money against the wrong
        // contract.
        const allProjects = await storage.getProjects({ includeArchived: true });
        const allContractors = await storage.getContractors();
        const match = await matchToProject(parsed, allProjects, allContractors);
        if (!match.contractorId) {
          await park(doc, fingerprint, "Invoice parked: could not identify the contractor for unique devis matching.");
          return;
        }
        const candidates = await storage.getDevisByProjectAndContractor(doc.projectId, match.contractorId);
        if (candidates.length !== 1) {
          await park(
            doc,
            fingerprint,
            `Invoice parked: ${candidates.length === 0 ? "no" : `${candidates.length}`} devis match for this contractor — attach manually.`,
          );
          return;
        }
        const result = await processInvoiceUpload(candidates[0].id, file, parsed);
        if (result.success) {
          const invoiceId = (result.data as { invoice: { id: number } }).invoice.id;
          await storage.updateProjectIntakeDocument(doc.id, {
            analysisState: "analyzed",
            routingState: "routed",
            promotedKind: "invoice",
            promotedId: invoiceId,
          });
          return;
        }
        if (result.status === 503) {
          throw new TransientIntakeError(
            `invoice routing transient: ${(result.data as { message?: string }).message ?? "unknown"}`,
          );
        }
        await park(doc, fingerprint, `Invoice routing failed: ${(result.data as { message?: string }).message ?? "unknown"}`);
        return;
      }
      default: {
        // situation / avenant / other / unknown — detected but parked for
        // manual routing (handled by a later task).
        await park(doc, fingerprint, `Parked: document type "${parsed.documentType}" is not auto-routed yet.`);
        return;
      }
    }
  });
}

async function markDuplicate(
  doc: ProjectIntakeDocument,
  fingerprint: string,
  originalId: number,
  contentHash: string | null,
): Promise<void> {
  // A duplicate is NOT promoted into a typed record, so promotedKind /
  // promotedId stay null (those columns mean "the devis/invoice this doc
  // became"). The link back to the original intake doc lives in
  // extracted_data + the human-readable note instead.
  await storage.updateProjectIntakeDocument(doc.id, {
    contentFingerprint: fingerprint,
    analysisState: "analyzed",
    routingState: "duplicate",
    extractedData: { duplicateOfIntakeDocumentId: originalId, ...(contentHash ? { contentHash } : {}) },
    notes: appendNote(doc.notes, `Duplicate of intake document #${originalId}.`),
  });
}

async function park(doc: ProjectIntakeDocument, fingerprint: string, reason: string): Promise<void> {
  await storage.updateProjectIntakeDocument(doc.id, {
    contentFingerprint: fingerprint,
    analysisState: "analyzed",
    routingState: "parked",
    notes: appendNote(doc.notes, reason),
  });
}

function appendNote(existing: string | null, note: string): string {
  return existing ? `${existing}\n${note}` : note;
}

/** Sweep all `pending` rows whose nextAttemptAt has elapsed. */
export async function sweepPendingIntakeJobs(): Promise<void> {
  try {
    const reclaimed = await storage.reclaimStaleIntakeJobs(STALE_IN_FLIGHT_RECLAIM_MS);
    if (reclaimed > 0) {
      console.warn(`[IntakeQueue] reclaimed ${reclaimed} stale in_flight job(s)`);
    }
    const due = await storage.listDueIntakeJobs(20);
    for (const row of due) {
      await attemptIntakeJob(row.id).catch((err) => {
        console.error(`[IntakeQueue] sweep attempt for job ${row.id} crashed:`, err);
      });
    }
  } catch (err) {
    console.error("[IntakeQueue] sweep failed:", err);
  }
}

export function startIntakeJobSweeper(intervalMs: number = 60_000): void {
  if (sweeperInterval) return;
  sweeperInterval = setInterval(() => {
    sweepPendingIntakeJobs().catch(console.error);
  }, intervalMs);
  console.log(`[IntakeQueue] sweeper started (every ${Math.round(intervalMs / 1000)}s)`);
}

export function stopIntakeJobSweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}
