/**
 * Retry policy for background email-document processing (Task #310).
 *
 * Kept in its own dependency-free module so both the document parser
 * (which records the outcome of a failed attempt) and the sweeper
 * service can import it without creating a module cycle, and so the
 * decision logic is trivially unit-testable.
 */

export const EMAIL_DOC_MAX_ATTEMPTS = 5;

/** Backoff between attempts (ms), indexed by the attempt that just failed. */
export const EMAIL_DOC_BACKOFF_MS: readonly number[] = [
  60_000, // after attempt 1 → 1 min
  5 * 60_000, // after attempt 2 → 5 min
  15 * 60_000, // after attempt 3 → 15 min
  60 * 60_000, // after attempt 4 → 1 h
];

export interface EmailDocRetryDecision {
  /** Next extraction_status to persist. */
  status: "pending" | "failed";
  /** Backoff delay before the next attempt (ms); null when terminal. */
  retryInMs: number | null;
}

/**
 * Decide what happens after a failed processing attempt.
 * @param attempts number of attempts INCLUDING the one that just failed
 * @param transient whether the failure looked transient (AI 503, network)
 */
export function decideEmailDocRetry(attempts: number, transient: boolean): EmailDocRetryDecision {
  if (!transient || attempts >= EMAIL_DOC_MAX_ATTEMPTS) {
    return { status: "failed", retryInMs: null };
  }
  const wait = EMAIL_DOC_BACKOFF_MS[Math.min(attempts - 1, EMAIL_DOC_BACKOFF_MS.length - 1)];
  return { status: "pending", retryInMs: wait };
}
