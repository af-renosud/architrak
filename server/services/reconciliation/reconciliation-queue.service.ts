/**
 * Background reconciliation queue (Task #231).
 *
 * Each project gets at most one queue row (`reconciliation_jobs`,
 * UNIQUE on project_id). Multiple document arrivals coalesce into a
 * single pending run. A process-local sweeper claims `pending` rows
 * (lease → `in_flight`), runs the overlap-detection pass, and either
 * succeeds, retries with exponential backoff, or dead-letters after
 * MAX_RECONCILIATION_ATTEMPTS — mirroring the proven intake_jobs /
 * drive_uploads / pennylane_pushes machinery.
 *
 * The run NEVER moves money and fires NO user-facing alert: it only
 * (re)computes structured overlap cases. Disabled wholesale by the
 * OVERLAP_DETECTION_ENABLED kill switch.
 */

import { storage } from "../../storage";
import { env } from "../../env";
import { runProjectReconciliation } from "./overlap-detection.service";
import { reconcileAccountingStates } from "./resolution.service";

export const MAX_RECONCILIATION_ATTEMPTS = 5;

// Backoff schedule (ms) between attempts. Index = attempt number that
// just failed (1..4). Mirrors the intake / drive_uploads schedule.
const BACKOFF_MS: readonly number[] = [
  10_000, // after attempt 1 → 10s
  30_000, // after attempt 2 → 30s
  120_000, // after attempt 3 → 2m
  300_000, // after attempt 4 → 5m
];

// Lease window for an in_flight claim — reclaim rows wedged by a crash
// between claim and finish. Well above any realistic run time.
export const STALE_IN_FLIGHT_RECLAIM_MS = 10 * 60 * 1000;

let sweeperInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Enqueue (or coalesce into) a reconciliation run for a project. Fires an
 * inline first attempt for a freshly-armed row so a single new document
 * gets reconciled promptly without waiting for the next sweep tick.
 * Best-effort: never throws into the caller (the ingest pipeline).
 */
export async function enqueueReconciliation(projectId: number): Promise<void> {
  if (!env.OVERLAP_DETECTION_ENABLED) return;
  try {
    const row = await storage.upsertReconciliationJob(projectId);
    if (row.state === "pending" && row.attempts === 0) {
      attemptReconciliationJob(row.id).catch((err) => {
        console.error(`[Reconciliation] inline first attempt for job ${row.id} crashed:`, err);
      });
    }
  } catch (err) {
    console.error(`[Reconciliation] enqueue failed for project #${projectId}:`, err);
  }
}

/**
 * Single attempt: claim the row (the claim UPDATE is the lock), run the
 * pass, and settle the row (succeeded / pending-retry / dead_letter).
 */
export async function attemptReconciliationJob(jobId: number): Promise<void> {
  const claimed = await storage.claimReconciliationJobForAttempt(jobId);
  if (!claimed) return; // someone else grabbed it / already terminal
  const attempts = claimed.attempts + 1;
  try {
    const summary = await runProjectReconciliation(claimed.projectId);
    // Task #232 — apply the accounting-state consequences of this pass:
    // auto-supersede proven members, promote cleared provisional devis. Kept
    // OUTSIDE runProjectReconciliation (detection stays money-free) and INSIDE
    // the attempt so a transient failure here retries with the same backoff.
    await reconcileAccountingStates(claimed.projectId);
    await storage.markReconciliationJobSucceeded({ jobId, attempts });
    console.log(
      `[Reconciliation] project ${summary.projectId}: ${summary.detected} case(s) ` +
      `(${summary.proven} proven, ${summary.needsReview} needs-review, ${summary.withdrawn} withdrawn; ` +
      `${summary.devisConsidered} devis, ai=${summary.aiUsed})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempts >= MAX_RECONCILIATION_ATTEMPTS) {
      await storage.markReconciliationJobDeadLettered({ jobId, attempts, lastError: message });
      console.error(`[Reconciliation] job ${jobId} dead-lettered after ${attempts} attempts:`, message);
    } else {
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
      const nextAttemptAt = new Date(Date.now() + delay);
      await storage.markReconciliationJobPendingRetry({ jobId, attempts, lastError: message, nextAttemptAt });
      console.warn(`[Reconciliation] job ${jobId} failed (attempt ${attempts}), retrying in ${Math.round(delay / 1000)}s:`, message);
    }
  }
}

export async function sweepPendingReconciliationJobs(): Promise<void> {
  try {
    const reclaimed = await storage.reclaimStaleReconciliationJobs(STALE_IN_FLIGHT_RECLAIM_MS);
    if (reclaimed > 0) {
      console.warn(`[Reconciliation] reclaimed ${reclaimed} stale in_flight job(s)`);
    }
    const due = await storage.listDueReconciliationJobs(20);
    for (const row of due) {
      await attemptReconciliationJob(row.id).catch((err) => {
        console.error(`[Reconciliation] sweep attempt for job ${row.id} crashed:`, err);
      });
    }
  } catch (err) {
    console.error("[Reconciliation] sweep failed:", err);
  }
}

export function startReconciliationSweeper(intervalMs: number = 60_000): void {
  if (sweeperInterval) return;
  if (!env.OVERLAP_DETECTION_ENABLED) {
    console.log("[Reconciliation] sweeper disabled (OVERLAP_DETECTION_ENABLED=false)");
    return;
  }
  sweeperInterval = setInterval(() => {
    sweepPendingReconciliationJobs().catch(console.error);
  }, intervalMs);
  console.log(`[Reconciliation] sweeper started (every ${Math.round(intervalMs / 1000)}s)`);
}

export function stopReconciliationSweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}
