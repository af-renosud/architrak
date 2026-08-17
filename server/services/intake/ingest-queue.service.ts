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
 *        - situation        → unique devis match; number matches an existing
 *                             situations row → attach signed PDF (Task #449);
 *                             otherwise unique mode_b devis → DRAFT situation
 *                             with per-line claimed % (Task #450)
 *        - commande         → unique devis match → marche_documents row
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
import { enqueueReconciliation } from "../reconciliation/reconciliation-queue.service";
import type { ParsedDocument } from "../../gmail/document-parser";
import type { InsertMarcheDocument, ProjectIntakeDocument } from "@shared/schema";

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
    // Task #310 — gmail-mirrored docs arrive with the email-side extraction
    // already attached (marked preParsedFromEmail). Reuse it instead of
    // paying for a second identical Gemini call; everything downstream
    // (dedup, routing) is agnostic to where the parse came from.
    const prior = doc.extractedData as (ParsedDocument & { preParsedFromEmail?: boolean }) | null;
    const parsed: ParsedDocument =
      prior && prior.preParsedFromEmail === true && typeof prior.documentType === "string"
        ? prior
        : await parseDocument(buffer, doc.fileName);

    // Task #425 — deterministic firm-identity gate BEFORE dedup/routing.
    // Rewrites documentType in place so the firm's own honoraires invoices
    // (architect_fee_invoice) never reach the contractor devis/invoice
    // paths, and downgrades hallucinated architect_fee_invoice claims whose
    // issuer is not the firm back to plain "invoice".
    const { applyFirmGateToParsed } = await import("../architect-fee-invoice.service");
    const firmGate = applyFirmGateToParsed(parsed);
    if (firmGate.gateReason) {
      console.log(`[intake-queue] Firm-identity gate on intake doc ${doc.id}: ${firmGate.gateReason}`);
    }

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
    const extractedData: Record<string, unknown> = { ...parsed, contentHash };
    await storage.updateProjectIntakeDocument(doc.id, {
      contentFingerprint: fingerprint,
      extractedData,
    });

    // 5b. System-wide dedup against ALL existing typed devis/invoice records
    // in the project (not just intake documents) by business identity:
    // document number, contractor, HT amount. Catches re-scraped copies of
    // records loaded before the intake system existed. Pure comparison logic
    // lives in shared/intake-dedup.ts; still inside the per-project lock.
    if (parsed.documentType === "quotation" || parsed.documentType === "invoice" || parsed.documentType === "acompte") {
      const { evaluateIntakeDedup, normalizeRef } = await import("@shared/intake-dedup");
      const [projectDevis, projectInvoices, allContractorRows] = await Promise.all([
        storage.getDevisByProject(doc.projectId),
        storage.getInvoicesByProject(doc.projectId),
        storage.getContractors(),
      ]);
      const contractorNames: Record<number, string> = {};
      for (const c of allContractorRows) contractorNames[c.id] = c.name;
      // Task #593 — line-aware dedup: for devis whose reference matches the
      // incoming extraction, load their line items so a same-ref/same-total
      // REVISION (items swapped at equal cost) parks for review instead of
      // being silently dropped as a duplicate. Only ref-matching devis are
      // hydrated (usually 0-1 rows), keeping the pass cheap.
      let dedupDevis: ((typeof projectDevis)[number] & {
        lineItems?: { description: string | null; quantity: string | null; unitPrice: string | null; total: string | null }[];
      })[] = projectDevis;
      if (parsed.documentType === "quotation") {
        const incomingRefs = new Set(
          [parsed.devisNumber, parsed.reference].map(normalizeRef).filter((r) => r.length > 0),
        );
        dedupDevis = await Promise.all(
          projectDevis.map(async (d) => {
            const refMatch =
              incomingRefs.size > 0 &&
              [normalizeRef(d.devisNumber), normalizeRef(d.devisCode)].some((r) => r.length > 0 && incomingRefs.has(r));
            if (!refMatch) return d;
            const lines = await storage.getDevisLineItems(d.id);
            return {
              ...d,
              lineItems: lines.map((li) => ({
                description: li.description,
                quantity: li.quantity,
                unitPrice: li.unitPriceHt,
                total: li.totalHt,
              })),
            };
          }),
        );
      }
      const dedup = evaluateIntakeDedup(
        { ...parsed, lineItems: parsed.lineItems ?? null },
        dedupDevis,
        projectInvoices,
        contractorNames,
      );
      if (dedup.verdict === "duplicate") {
        const refKey = dedup.matchKind === "devis" ? "duplicateOfDevisId" : "duplicateOfInvoiceId";
        await storage.updateProjectIntakeDocument(doc.id, {
          contentFingerprint: fingerprint,
          analysisState: "analyzed",
          routingState: "duplicate",
          extractedData: { ...extractedData, [refKey]: dedup.matchId },
          notes: appendNote(doc.notes, dedup.reason),
        });
        return;
      }
      if (dedup.verdict === "review") {
        await park(doc, fingerprint, dedup.reason);
        return;
      }
    }

    const file = {
      originalname: doc.fileName,
      buffer,
      mimetype: doc.mimeType ?? "application/pdf",
    };

    // 6. Route by documentType. The user may have DELETED the intake
    // document while analysis was running — re-check existence immediately
    // before any draft-creation side effect so a deleted doc can't still
    // spawn a typed devis/invoice.
    if (!(await storage.getProjectIntakeDocument(doc.id))) {
      console.log(`[intake-queue] Intake document ${doc.id} was deleted mid-analysis — skipping routing`);
      return;
    }
    switch (parsed.documentType) {
      case "architect_fee_invoice": {
        // The firm's OWN honoraires invoice — never a contractor document.
        // Capture as evidence in the dedicated review queue and park the
        // intake doc awaiting human review. No draft, no money movement
        // (confirmation is Task #426).
        const { captureArchitectFeeInvoice } = await import("../architect-fee-invoice.service");
        try {
          const capture = await captureArchitectFeeInvoice({
            parsed,
            gateReason: firmGate.gateReason,
            intakeDocumentId: doc.id,
            fileName: doc.fileName,
            storageKey: doc.storageKey,
          });
          await storage.updateProjectIntakeDocument(doc.id, {
            analysisState: "analyzed",
            routingState: "parked",
            notes: appendNote(
              doc.notes,
              `Architect fee invoice (facture d'honoraires) — awaiting review in the fee-invoice queue (evidence #${capture.id}).`,
            ),
          });
        } catch (err) {
          throw new TransientIntakeError(
            `architect fee-invoice capture failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
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
          // A new typed devis may overlap/supersede earlier ones — trigger
          // the per-project reconciliation pass (idempotent, coalescing,
          // never moves money). Fire-and-forget; failures self-retry.
          void enqueueReconciliation(doc.projectId);
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
        // Second existence check: the matching lookups above take time and
        // a delete may have landed since the pre-switch check.
        if (!(await storage.getProjectIntakeDocument(doc.id))) {
          console.log(`[intake-queue] Intake document ${doc.id} was deleted mid-analysis — skipping invoice routing`);
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
          // A new invoice can shift a devis's effective scope — re-run the
          // per-project reconciliation pass (idempotent, coalescing).
          void enqueueReconciliation(doc.projectId);
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
      case "situation": {
        // Task #449 — a signed "Situation de travaux" PDF. Auto-attach ONLY
        // on an exact, unambiguous chain: contractor identified → exactly
        // one devis for (project, contractor) → an existing situations row
        // with the extracted situation number that has no source PDF yet.
        // Anything weaker parks for the reviewed one-click attach flow.
        // Never creates or mutates money fields.
        const allProjects = await storage.getProjects({ includeArchived: true });
        const allContractors = await storage.getContractors();
        const match = await matchToProject(parsed, allProjects, allContractors);
        if (!match.contractorId) {
          await park(doc, fingerprint, "Situation parked: could not identify the contractor for unique devis matching — attach manually.");
          return;
        }
        const candidates = await storage.getDevisByProjectAndContractor(doc.projectId, match.contractorId);
        if (candidates.length !== 1) {
          await park(
            doc,
            fingerprint,
            `Situation parked: ${candidates.length === 0 ? "no" : `${candidates.length}`} devis match for this contractor — attach manually.`,
          );
          return;
        }
        const situationNumber =
          typeof parsed.situationNumber === "number" && Number.isInteger(parsed.situationNumber) && parsed.situationNumber > 0
            ? parsed.situationNumber
            : null;
        const existing =
          situationNumber == null
            ? undefined
            : (await storage.getSituationsByDevis(candidates[0].id)).find(
                (s) => s.situationNumber === situationNumber,
              );
        if (!existing) {
          // Task #450 — no existing situations row to attach evidence to:
          // this is a NEW contractor claim. On a mode_b devis, create a
          // DRAFT situation with per-line claimed % for the traffic-light
          // review; anything else parks for manual handling.
          if (candidates[0].invoicingMode !== "mode_b") {
            await park(doc, fingerprint, "Situation parked: matched devis is not mode_b (no line items to review against) and no existing situation to attach to — attach manually.");
            return;
          }
          // Second existence check (see invoice branch): a delete may have
          // landed while the matching lookups ran.
          if (!(await storage.getProjectIntakeDocument(doc.id))) {
            console.log(`[intake-queue] Intake document ${doc.id} was deleted mid-analysis — skipping situation routing`);
            return;
          }
          const { createDraftSituationFromParsed, SituationReviewError } = await import("../situation-review.service");
          try {
            const { situation } = await createDraftSituationFromParsed({
              devis: candidates[0],
              parsed,
              fileName: doc.fileName,
              storageKey: doc.storageKey,
            });
            await storage.updateProjectIntakeDocument(doc.id, {
              analysisState: "analyzed",
              routingState: "routed",
              promotedKind: "situation",
              promotedId: situation.id,
              contentFingerprint: fingerprint,
            });
            return;
          } catch (err) {
            if (err instanceof SituationReviewError) {
              // Deterministic rejection (no % lines, existing draft, …) —
              // park with the reason; retrying won't change the outcome.
              await park(doc, fingerprint, `Situation parked: ${err.message}`);
              return;
            }
            throw new TransientIntakeError(
              `situation routing failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (existing.sourceStorageKey) {
          await park(
            doc,
            fingerprint,
            `Situation parked: situation n°${situationNumber} already has a source PDF attached — review manually.`,
          );
          return;
        }
        // Re-check existence right before the side effect (delete race).
        if (!(await storage.getProjectIntakeDocument(doc.id))) {
          console.log(`[intake-queue] Intake document ${doc.id} was deleted mid-analysis — skipping situation routing`);
          return;
        }
        // Auto-attached = unconfirmed draft attachment; an operator confirms
        // it from the situation record (draft→confirm). Claim (unrouted→
        // routed) + attach run in ONE transaction, conditional on the
        // situation having no source PDF yet and guarded by the partial
        // unique index on situations.source_intake_document_id — if any
        // concurrent attach wins the race, park instead of overwriting.
        const result = await storage.attachSituationSourceAndRouteIntake({
          situationId: existing.id,
          intakeDocumentId: doc.id,
          sourceStorageKey: doc.storageKey,
          sourceFileName: doc.fileName,
          sourceUploadedBy: "intake-auto",
          confirmed: false,
          intakeNote: `Signed situation PDF attached to situation n°${situationNumber} (unconfirmed — review on the record).`,
          existingIntakeNotes: doc.notes,
          expectedRoutingState: "unrouted",
          contentFingerprint: fingerprint,
        });
        if ("conflict" in result) {
          await park(
            doc,
            fingerprint,
            `Situation parked: could not auto-attach to situation n°${situationNumber} (${result.conflict}) — review manually.`,
          );
          return;
        }
        return;
      }
      case "commande": {
        // Task #449 — a signed "Bon de commande". Retained as a
        // marche_documents evidence row. Auto-route only when the
        // contractor is identified AND exactly one devis matches
        // (project + contractor); otherwise park for reviewed attach.
        const allProjects = await storage.getProjects({ includeArchived: true });
        const allContractors = await storage.getContractors();
        const match = await matchToProject(parsed, allProjects, allContractors);
        if (!match.contractorId) {
          await park(doc, fingerprint, "Bon de commande parked: could not identify the contractor for unique devis matching — attach manually.");
          return;
        }
        const candidates = await storage.getDevisByProjectAndContractor(doc.projectId, match.contractorId);
        if (candidates.length !== 1) {
          await park(
            doc,
            fingerprint,
            `Bon de commande parked: ${candidates.length === 0 ? "no" : `${candidates.length}`} devis match for this contractor — attach manually.`,
          );
          return;
        }
        if (!(await storage.getProjectIntakeDocument(doc.id))) {
          console.log(`[intake-queue] Intake document ${doc.id} was deleted mid-analysis — skipping commande routing`);
          return;
        }
        // Transactional claim (unrouted→routed) + evidence insert, guarded
        // by the unique-per-intake-doc index — conflicts park for review.
        const result = await storage.createMarcheDocumentAndRouteIntake({
          data: {
            projectId: doc.projectId,
            kind: "commande",
            storageKey: doc.storageKey,
            fileName: doc.fileName,
            devisId: candidates[0].id,
            marcheId: candidates[0].marcheId ?? null,
            sourceIntakeDocumentId: doc.id,
            extractedData: extractedData as InsertMarcheDocument["extractedData"],
            uploadedBy: "intake-auto",
          },
          intakeNote: "Signed bon de commande retained as marché evidence (unconfirmed — review on the record).",
          existingIntakeNotes: doc.notes,
          expectedRoutingState: "unrouted",
          contentFingerprint: fingerprint,
        });
        if ("conflict" in result) {
          await park(doc, fingerprint, `Bon de commande parked: could not auto-retain (${result.conflict}) — review manually.`);
          return;
        }
        return;
      }
      default: {
        // avenant / other / unknown — detected but parked for
        // manual routing (handled by a later task). When the "unknown" was
        // caused by a hard parse/conversion failure (e.g. a PDF that could
        // not be rasterised), surface that reason so the operator knows to
        // re-upload a flattened copy rather than seeing a generic note.
        const parseFailure =
          parsed.documentType === "unknown" &&
          typeof parsed.rawText === "string" &&
          parsed.rawText.startsWith("Parse failed");
        const reason = parseFailure
          ? `Parked: could not read this document — ${parsed.rawText}. Re-upload a flattened / unprotected PDF.`
          : `Parked: document type "${parsed.documentType}" is not auto-routed yet.`;
        await park(doc, fingerprint, reason);
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
    // Repair queue/document drift: a document left on "analyzing" whose
    // job already reached a terminal error state can never be recovered by
    // the in_flight reclaim above, so force it to a terminal state.
    const repaired = await storage.failOrphanedAnalyzingIntakeDocuments();
    if (repaired > 0) {
      console.warn(`[IntakeQueue] drift-repaired ${repaired} document(s) stuck on "analyzing" with a terminal job`);
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
