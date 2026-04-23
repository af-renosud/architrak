import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb } from "../db";
import { postMergeTransientFailures } from "@shared/schema";

// Task #130 — escalation tracker for post-deploy maintenance scripts.
//
// Background: Task #126 added a transient-vs-schema-error classifier that ships
// a `[transient]`-tagged operator alert and lets the deploy continue when a
// post-merge maintenance script (page-hint backfill, contractor backfill, ...)
// exits non-zero without a schema-error fingerprint. Most of those failures
// genuinely self-heal on the next deploy. The downside: if the SAME source
// fails transiently deploy after deploy, the on-call learns to ignore the
// `[transient]` prefix and a real degradation (AI quota permanently cut,
// ArchiDoc auth rotated and forgotten, ...) hides for weeks.
//
// This module is the single source of truth for "how many consecutive deploys
// has source X failed?". A successful run clears the counter; once a source
// has failed transiently on POST_MERGE_ESCALATE_AFTER consecutive deploys
// (default 3), the NEXT failure (counter > threshold) is upgraded to
// `[escalated]` with the prior N failure timestamps in the body. So with the
// default threshold of 3, failures 1–3 ship `[transient]` and failure 4 is
// the first `[escalated]` alert.

export interface RecentFailure {
  /** ISO 8601 timestamp the failure was recorded. */
  timestamp: string;
  /** Process exit code reported by the maintenance script. */
  exitCode: number;
  /** Last few lines of the script's stderr/stdout (already truncated upstream). */
  logTail: string;
}

export interface RecordTransientFailureOptions {
  /** Optional injection point for tests / replay-DB callers. */
  db?: NodePgDatabase<Record<string, unknown>> | typeof defaultDb;
  /** "Now" override — defaults to `new Date()`. Tests use a fixed clock. */
  now?: Date;
  /**
   * How many recent failures to retain on the row. Older entries are dropped.
   * Default 10 — enough to give the on-call useful pattern context without
   * letting the jsonb column grow unbounded across years of flapping.
   */
  historyLimit?: number;
}

export interface RecordTransientFailureResult {
  /** Counter AFTER this failure was recorded (>= 1). */
  consecutiveFailures: number;
  /**
   * True when the source has now failed on MORE than `escalateAfter`
   * consecutive deploys — i.e. `consecutiveFailures > escalateAfter`. With
   * the default threshold of 3, failures 1/2/3 ship `[transient]` and the
   * 4th consecutive failure is the first `[escalated]` alert. Callers use
   * this to flip the alert subject prefix.
   */
  escalated: boolean;
  /** Most recent N failures, newest first, including the one just recorded. */
  recentFailures: RecentFailure[];
}

const DEFAULT_HISTORY_LIMIT = 10;

function parseRecentFailures(value: unknown): RecentFailure[] {
  if (!Array.isArray(value)) return [];
  const out: RecentFailure[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.timestamp === "string" &&
      typeof e.exitCode === "number" &&
      typeof e.logTail === "string"
    ) {
      out.push({ timestamp: e.timestamp, exitCode: e.exitCode, logTail: e.logTail });
    }
  }
  return out;
}

/**
 * Record a transient failure for `sourceTag`. Increments the consecutive
 * counter, prepends the failure to the bounded history, and returns whether
 * the new counter value crosses `escalateAfter` (so the caller can decide the
 * alert subject prefix). Throws on database error — the caller (the alert
 * dispatcher) catches and degrades to `[transient]` rather than blocking the
 * deploy.
 */
export async function recordTransientFailure(
  sourceTag: string,
  exitCode: number,
  logTail: string,
  escalateAfter: number,
  options: RecordTransientFailureOptions = {},
): Promise<RecordTransientFailureResult> {
  const db = options.db ?? defaultDb;
  const now = options.now ?? new Date();
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  const newEntry: RecentFailure = {
    timestamp: now.toISOString(),
    exitCode,
    logTail,
  };

  const existing = await db
    .select()
    .from(postMergeTransientFailures)
    .where(eq(postMergeTransientFailures.sourceTag, sourceTag));

  const prior = existing[0];
  const priorHistory = prior ? parseRecentFailures(prior.recentFailures) : [];
  const nextHistory = [newEntry, ...priorHistory].slice(0, historyLimit);
  const nextCount = (prior?.consecutiveFailures ?? 0) + 1;

  if (prior) {
    await db
      .update(postMergeTransientFailures)
      .set({
        consecutiveFailures: nextCount,
        lastExitCode: exitCode,
        lastFailureAt: now,
        recentFailures: nextHistory,
        updatedAt: now,
      })
      .where(eq(postMergeTransientFailures.sourceTag, sourceTag));
  } else {
    await db.insert(postMergeTransientFailures).values({
      sourceTag,
      consecutiveFailures: nextCount,
      lastExitCode: exitCode,
      lastFailureAt: now,
      recentFailures: nextHistory,
      updatedAt: now,
    });
  }

  return {
    consecutiveFailures: nextCount,
    escalated: nextCount > escalateAfter,
    recentFailures: nextHistory,
  };
}

export interface ClearTransientFailuresOptions {
  db?: NodePgDatabase<Record<string, unknown>> | typeof defaultDb;
  now?: Date;
}

export interface ClearTransientFailuresResult {
  /** Counter value BEFORE the clear (so callers can log "broke a streak of N"). */
  previousConsecutiveFailures: number;
}

/**
 * Reset the consecutive-failure counter for `sourceTag` after a successful
 * run. The history rows are kept (for forensic value) but the counter goes
 * back to 0 so a future one-off blip never escalates to `[escalated]`.
 *
 * No-op (returns 0) when the row doesn't exist — i.e. the source has never
 * failed transiently. We do NOT insert a row in that case to keep the table
 * sparse: rows only exist for sources that have actually failed.
 */
export async function clearTransientFailures(
  sourceTag: string,
  options: ClearTransientFailuresOptions = {},
): Promise<ClearTransientFailuresResult> {
  const db = options.db ?? defaultDb;
  const now = options.now ?? new Date();

  const existing = await db
    .select()
    .from(postMergeTransientFailures)
    .where(eq(postMergeTransientFailures.sourceTag, sourceTag));

  const prior = existing[0];
  if (!prior || prior.consecutiveFailures === 0) {
    return { previousConsecutiveFailures: prior?.consecutiveFailures ?? 0 };
  }

  await db
    .update(postMergeTransientFailures)
    .set({
      consecutiveFailures: 0,
      lastClearedAt: now,
      updatedAt: now,
    })
    .where(eq(postMergeTransientFailures.sourceTag, sourceTag));

  return { previousConsecutiveFailures: prior.consecutiveFailures };
}

/**
 * Format the recent-failure history for inclusion in an `[escalated]` alert
 * body. Skips the just-recorded failure (index 0) — that one is already
 * implicit in the alert that triggered this format. Returns an empty string
 * when there's no prior history (which shouldn't happen on an escalation but
 * we tolerate it defensively).
 */
export function formatEscalationHistory(history: RecentFailure[]): string {
  const prior = history.slice(1);
  if (prior.length === 0) return "";
  const lines = prior.map(
    (f, i) => `  ${i + 1}. ${f.timestamp} — exit ${f.exitCode}`,
  );
  return `Previous consecutive transient failures (most recent first):\n${lines.join("\n")}`;
}

/**
 * Parse the escalation threshold from the env. Default 3. Values < 1 fall back
 * to the default (escalating on the first failure would defeat the entire
 * "let transients self-heal" design from #126). NaN / non-numeric strings also
 * fall back so a typo doesn't silently disable escalation.
 */
export function parseEscalateAfter(raw: string | undefined): number {
  const DEFAULT = 3;
  if (!raw) return DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT;
  return n;
}

// Re-export for tests + callers.
export { postMergeTransientFailures };
