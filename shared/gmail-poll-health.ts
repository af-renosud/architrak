/**
 * Gmail inbox-scan health classification.
 *
 * Background: in production the Gmail poller silently stopped for over two
 * months and nobody noticed — the dashboard read the monitor's IN-MEMORY
 * status, which resets to "idle / Never" on every restart and therefore
 * looked unremarkable while `users.gmail_last_poll_at` sat at a 10-week-old
 * timestamp. This module classifies health from the PERSISTED per-user poll
 * columns so a dead scanner is loudly visible no matter how many times the
 * process restarted since.
 *
 * Pure and side-effect free (callers pass `now`) so it is unit-testable and
 * usable from both server routes and the client dashboard.
 */

/** Poll cadence is 15 min; anything beyond 2h means the loop is not running. */
export const GMAIL_POLL_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export type GmailPollHealthLevel =
  | "ok" // scanned recently, last scan succeeded
  | "stale" // last successful scan is older than the threshold — capture may be down
  | "auth_revoked" // Google access was revoked — needs re-link
  | "error" // last scan errored (but within threshold — will retry)
  | "never" // linked, but no scan has ever run
  | "not_linked"; // no Gmail inbox linked at all

export interface GmailPollHealthInput {
  /** Whether the user has a stored Gmail refresh token. */
  linked: boolean;
  /** ISO string or Date of the last poll attempt; null = never polled. */
  lastPollAt: string | Date | null | undefined;
  /** Persisted `gmail_last_poll_status` value; null = never polled. */
  lastPollStatus: string | null | undefined;
  /** Current time — passed in so the classification is deterministic. */
  now: Date;
  /** Override the staleness threshold (ms). Defaults to 2 hours. */
  staleThresholdMs?: number;
}

export interface GmailPollHealth {
  level: GmailPollHealthLevel;
  /** Milliseconds since the last poll attempt; null when never polled. */
  ageMs: number | null;
  /** Operator-facing message. Non-null for every non-"ok" level. */
  message: string | null;
}

/** Human-readable duration for warning copy: "45 minutes", "3 hours", "69 days". */
export function formatPollAge(ageMs: number): string {
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function classifyGmailPollHealth(input: GmailPollHealthInput): GmailPollHealth {
  const threshold = input.staleThresholdMs ?? GMAIL_POLL_STALE_THRESHOLD_MS;
  const last =
    input.lastPollAt == null
      ? null
      : input.lastPollAt instanceof Date
        ? input.lastPollAt
        : new Date(input.lastPollAt);
  const ageMs = last && !Number.isNaN(last.getTime()) ? input.now.getTime() - last.getTime() : null;

  if (!input.linked) {
    return {
      level: "not_linked",
      ageMs,
      message: "No Gmail inbox is linked — emailed documents are not being captured.",
    };
  }

  if (input.lastPollStatus === "auth_revoked") {
    return {
      level: "auth_revoked",
      ageMs,
      message: "Google access was revoked — reconnect Gmail to resume automatic document capture.",
    };
  }

  if (ageMs == null) {
    return {
      level: "never",
      ageMs: null,
      message: "Inbox has never been scanned — automatic document capture may be down.",
    };
  }

  if (ageMs > threshold) {
    return {
      level: "stale",
      ageMs,
      message: `Inbox last scanned ${formatPollAge(ageMs)} ago — automatic document capture may be down.`,
    };
  }

  if (input.lastPollStatus === "error") {
    return {
      level: "error",
      ageMs,
      message: "Last inbox scan errored — it will retry automatically.",
    };
  }

  return { level: "ok", ageMs, message: null };
}
