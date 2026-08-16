/**
 * Background email-document processor (Task #310).
 *
 * Gmail polling captures attachments into `email_documents` at
 * extraction_status='pending', but nothing ever processed them
 * automatically — the extraction → project-match → intake pipeline only
 * ran from a manual admin route, so captured devis silently piled up.
 *
 * This sweeper drains pending email documents in the background:
 *   - picks up to SWEEP_BATCH_SIZE due docs per tick (oldest received
 *     first), received on/after the intake watermark (Task #322 — the
 *     beta-reset cutoff; older mail was explicitly written off);
 *   - runs processEmailDocument concurrently within the batch (Task #317),
 *     capped by MAX_CONCURRENT_EXTRACTIONS — same total AI calls per tick
 *     (same quota), but a ~45 s extraction no longer serialises the batch,
 *     lifting drain speed from ~1/min to ~5/min;
 *   - transient failures self-heal via the retry/backoff bookkeeping in
 *     processEmailDocument (decideEmailDocRetry); permanent ones land on
 *     terminal 'failed';
 *   - matched docs flow into project intake automatically via the
 *     updateEmailDocument → mirrorEmailDocumentToIntake bridge; unmatched
 *     ones end at 'needs_review' with no project — visible in the email
 *     queue for manual assignment;
 *   - reclaims docs wedged on 'processing' (crash mid-extraction) back to
 *     'pending' after PROCESSING_STALE_MS.
 */
import pLimit from "p-limit";
import { storage } from "../storage";
import { getEmailIntakeCutoff } from "./email-intake-cutoff";

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH_SIZE = 5;

// Task #503 — retention window for parked low-value documents
// (low_relevance / unmatched_sender). After this, they auto-expire to
// terminal 'skipped' with an audit note (never deleted; still visible under
// the Skipped filter). 'archived_project_candidate' never expires.
const PARKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_CONCURRENT_EXTRACTIONS = 5;
const PROCESSING_STALE_MS = 15 * 60_000;

let timer: NodeJS.Timeout | null = null;
let sweeping = false;

export async function sweepPendingEmailDocuments(): Promise<void> {
  // A batch of extractions can outlast the tick interval; never overlap.
  if (sweeping) return;
  sweeping = true;
  try {
    const reclaimed = await storage.reclaimStaleProcessingEmailDocuments(PROCESSING_STALE_MS);
    if (reclaimed > 0) {
      console.warn(`[EmailDocProcessor] Reclaimed ${reclaimed} document(s) wedged on 'processing' back to 'pending'.`);
    }

    // Task #503 — retention pass: expire parked low-value docs that nobody
    // rescued within the window. Cheap conditional UPDATE, safe every tick.
    try {
      const expired = await storage.expireStaleParkedEmailDocuments(PARKED_RETENTION_MS);
      if (expired > 0) {
        console.log(`[EmailDocProcessor] Auto-expired ${expired} parked low-relevance/unmatched document(s) past the ${Math.round(PARKED_RETENTION_MS / 86_400_000)}-day retention window.`);
      }
    } catch (err) {
      console.error("[EmailDocProcessor] Retention pass failed:", err);
    }

    // Task #550 — purge pass: permanently delete skipped documents older
    // than the operator-configured retention window (default 30 days,
    // 0 = keep forever). Guards live in the storage method (promoted docs
    // and promoted mirrors are never purged); object files are deleted
    // post-commit only when no other row references the same storage key.
    try {
      await purgeExpiredSkippedDocuments();
    } catch (err) {
      console.error("[EmailDocProcessor] Purge pass failed:", err);
    }

    const due = await storage.listDueEmailDocuments(SWEEP_BATCH_SIZE, getEmailIntakeCutoff());
    if (due.length === 0) return;

    const { processEmailDocument } = await import("../gmail/document-parser");
    const limit = pLimit(MAX_CONCURRENT_EXTRACTIONS);
    // Concurrent within the batch (Task #317): allSettled so one crashing
    // doc never aborts the rest — processEmailDocument persists its own
    // failure state; we only log the unexpected ones.
    const results = await Promise.allSettled(
      due.map((doc) => limit(() => processEmailDocument(doc.id))),
    );
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(`[EmailDocProcessor] Unexpected error processing email document ${due[i].id}:`, result.reason);
      }
    });
  } catch (err) {
    console.error("[EmailDocProcessor] Sweep failed:", err);
  } finally {
    sweeping = false;
  }
}

// Task #550 — retention window setting for the permanent purge of skipped docs.
export const EMAIL_PURGE_DAYS_KEY = "email_doc_purge_days";
export const EMAIL_PURGE_DAYS_DEFAULT = 30;

// Task #550 — exported for tests.
export async function purgeExpiredSkippedDocuments(): Promise<number> {
  const raw = await storage.getAppSetting(EMAIL_PURGE_DAYS_KEY);
  const days = raw != null && Number.isFinite(Number(raw)) ? Number(raw) : EMAIL_PURGE_DAYS_DEFAULT;
  if (days <= 0) return 0; // auto-purge disabled

  const purged = await storage.purgeExpiredSkippedEmailDocuments(days * 24 * 60 * 60 * 1000);
  if (purged.length === 0) return 0;

  const { deleteDocument } = await import("../storage/object-storage");
  for (const { id, storageKey } of purged) {
    if (!storageKey) continue;
    try {
      if (await storage.isStorageKeyReferencedElsewhere(storageKey, id)) {
        console.log(`[EmailDocProcessor] Purged email doc ${id}; storage key still referenced elsewhere — keeping object`);
      } else {
        await deleteDocument(storageKey);
      }
    } catch (err) {
      console.warn(`[EmailDocProcessor] Failed to delete storage object for purged email doc ${id} (continuing):`, err);
    }
  }
  console.log(`[EmailDocProcessor] Purged ${purged.length} skipped email document(s) past the ${days}-day retention window.`);
  return purged.length;
}

export function startEmailDocumentSweeper(intervalMs: number = SWEEP_INTERVAL_MS): void {
  if (timer) return;
  console.log(`[EmailDocProcessor] Background email-document processing started (every ${Math.round(intervalMs / 1000)}s, batch ${SWEEP_BATCH_SIZE}, intake watermark ${getEmailIntakeCutoff().toISOString()}).`);
  // First sweep shortly after boot so a restart doesn't delay the queue.
  setTimeout(() => void sweepPendingEmailDocuments(), 5_000);
  timer = setInterval(() => void sweepPendingEmailDocuments(), intervalMs);
  timer.unref?.();
}

export function stopEmailDocumentSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
