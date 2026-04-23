/**
 * Runtime watchdog (Task #126).
 *
 * Polls `/healthz/deep` (added in Task #125) every N minutes from
 * inside the running server. On a transition from "last poll ok" to
 * "this poll failed", fires exactly ONE operator alert — re-armed
 * only after a successful poll. This dedupes so an extended outage
 * doesn't flood the on-call inbox.
 *
 * Why on top of the post-deploy smoke gate (#125): #125 only catches
 * regressions visible IMMEDIATELY after the deploy. The watchdog
 * catches regressions that appear later (a column dropped manually,
 * a DB connectivity blip lasting > 5 min, an external dependency
 * removing a table the schema still references, ...). Together they
 * close the "silent prod schema drift" loop.
 *
 * Skipped entirely when OPERATOR_ALERT_EMAIL is unset (no alerting
 * channel configured = no point in polling on a schedule).
 */

import { sendOperatorAlert as defaultSendOperatorAlert } from "./operator-alerts";

export interface WatchdogDeps {
  /** Probe URL — typically `${PUBLIC_BASE_URL || localhost}/healthz/deep`. */
  url: string;
  /** Polling cadence. Production default 5 min. */
  intervalMs: number;
  /** Per-request timeout. Watchdog must never hang. */
  requestTimeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  sendAlert?: typeof defaultSendOperatorAlert;
  /** Override for tests (fake setInterval / clearInterval pair). */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export interface WatchdogHandle {
  stop: () => void;
  /** Test-only: run one poll synchronously without waiting for the timer. */
  pollOnceForTest: () => Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function startHealthzWatchdog(deps: WatchdogDeps): WatchdogHandle {
  const {
    url,
    intervalMs,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = fetch,
    sendAlert = defaultSendOperatorAlert,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = deps;

  // Optimistic initial state: assume the system is healthy. The first
  // failure transition therefore fires an alert immediately rather
  // than waiting for a "recovery" we never had.
  let lastWasOk = true;
  let inFlight = false;

  const poll = async () => {
    // Re-entrancy guard: a slow probe must not stack up if intervalMs
    // is shorter than requestTimeoutMs. Drop overlapping ticks.
    if (inFlight) return;
    inFlight = true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let isOk = false;
      let detail = "";
      try {
        const res = await fetchImpl(url, { signal: controller.signal });
        const body = await res.text();
        isOk = res.status === 200;
        detail = isOk
          ? `status=200 body=${body.slice(0, 200)}`
          : `status=${res.status} body=${body.slice(0, 500)}`;
      } catch (err) {
        detail = `network error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        clearTimeout(timer);
      }

      if (isOk) {
        if (!lastWasOk) {
          console.log(
            `[healthz-watchdog] recovery — ${url} returned 200 again`,
          );
        }
        lastWasOk = true;
        return;
      }

      // Failure path. Only alert on the OK→FAIL transition.
      if (lastWasOk) {
        console.error(
          `[healthz-watchdog] failure transition — ${url} unhealthy: ${detail}`,
        );
        const body = [
          `Runtime health watchdog detected /healthz/deep failure.`,
          ``,
          `URL: ${url}`,
          `Detail: ${detail}`,
          ``,
          `This alert fires once per failure window — the next alert`,
          `will only fire after a successful poll re-arms the trigger.`,
          ``,
          `Likely causes: a column was dropped from a modeled table`,
          `post-deploy, the DB went away, or an in-process schema`,
          `drift was introduced without a migration. Cross-reference`,
          `recent migrations and /healthz/deep response body.`,
        ].join("\n");
        try {
          const result = await sendAlert({
            source: "healthz-watchdog",
            subject: "deep health check failing in production",
            body,
          });
          if (!result.delivered) {
            console.warn(
              `[healthz-watchdog] alert not delivered (${result.reason})`,
            );
          }
        } catch (err) {
          console.error(
            `[healthz-watchdog] alert dispatch threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        lastWasOk = false;
      } else {
        // Already in failure window — log but do not re-alert.
        console.warn(
          `[healthz-watchdog] still unhealthy: ${detail}`,
        );
      }
    } finally {
      inFlight = false;
    }
  };

  const handle = setIntervalImpl(() => {
    poll().catch((err) =>
      console.error("[healthz-watchdog] unexpected error:", err),
    );
  }, intervalMs);
  // Don't keep the event loop alive solely for the watchdog —
  // shutdown handlers should be able to drain without waiting on it.
  if (typeof (handle as NodeJS.Timeout).unref === "function") {
    (handle as NodeJS.Timeout).unref();
  }

  return {
    stop: () => clearIntervalImpl(handle),
    pollOnceForTest: poll,
  };
}
