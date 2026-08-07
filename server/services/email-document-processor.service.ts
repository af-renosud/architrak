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
 *     first), captured on/after EMAIL_DOC_BACKLOG_CUTOFF (the older
 *     backlog was explicitly written off by the user);
 *   - runs processEmailDocument sequentially — extraction is the rate
 *     limiter, so backlog drain stays gentle on the AI quota;
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
import { storage } from "../storage";
import { EMAIL_DOC_BACKLOG_CUTOFF } from "./email-doc-retry";

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH_SIZE = 3;
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

    const due = await storage.listDueEmailDocuments(SWEEP_BATCH_SIZE, EMAIL_DOC_BACKLOG_CUTOFF);
    if (due.length === 0) return;

    const { processEmailDocument } = await import("../gmail/document-parser");
    for (const doc of due) {
      try {
        await processEmailDocument(doc.id);
      } catch (err) {
        // processEmailDocument persists its own failure state; this guard
        // only keeps one crashing doc from aborting the rest of the batch.
        console.error(`[EmailDocProcessor] Unexpected error processing email document ${doc.id}:`, err);
      }
    }
  } catch (err) {
    console.error("[EmailDocProcessor] Sweep failed:", err);
  } finally {
    sweeping = false;
  }
}

export function startEmailDocumentSweeper(intervalMs: number = SWEEP_INTERVAL_MS): void {
  if (timer) return;
  console.log(`[EmailDocProcessor] Background email-document processing started (every ${Math.round(intervalMs / 1000)}s, batch ${SWEEP_BATCH_SIZE}, backlog cutoff ${EMAIL_DOC_BACKLOG_CUTOFF.toISOString().slice(0, 10)}).`);
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
