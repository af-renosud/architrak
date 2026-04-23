#!/usr/bin/env tsx
/**
 * Post-deploy smoke gate (Task #125).
 *
 * Polls `${PUBLIC_BASE_URL}/healthz/deep` for up to 60 seconds after a
 * deploy completes. Exits 0 on first 200, exits 1 on timeout or on any
 * non-200 response that persists past the polling window. Sends an
 * operator alert via the existing Gmail-backed channel before exiting
 * 1 so on-call sees the failure even if nobody is watching the deploy
 * log.
 *
 * Why a separate script instead of a startup self-check: the original
 * 2026-04-23 incident DID start cleanly (the migrator silently lied
 * about success). We need a probe that runs AFTER the new revision is
 * answering HTTP — i.e. a real readiness check from the outside.
 *
 * Resolution order for the probe URL:
 *   1. SMOKE_BASE_URL (override for ad-hoc runs)
 *   2. PUBLIC_BASE_URL (set in prod + dev workflows)
 *   3. http://localhost:5000 (last-resort default for local invocation)
 *
 * Exit codes:
 *   0  healthy within the polling window
 *   1  unhealthy / timeout (operator alert sent)
 *   2  configuration error (no URL resolvable, programmer error)
 */

import { sendOperatorAlert } from "../server/operations/operator-alerts";

const POLL_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
const POLL_INTERVAL_MS = Number(process.env.SMOKE_INTERVAL_MS ?? 2_000);
const REQUEST_TIMEOUT_MS = Number(process.env.SMOKE_REQUEST_TIMEOUT_MS ?? 10_000);

interface ProbeAttempt {
  status: number | null;
  body: string;
  error?: string;
}

async function probe(url: string): Promise<ProbeAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err) {
    return {
      status: null,
      body: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveUrl(): string | null {
  const base =
    process.env.SMOKE_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    "http://localhost:5000";
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/healthz/deep`;
}

export async function runSmoke(): Promise<number> {
  const url = resolveUrl();
  if (!url) {
    console.error(
      "[post-deploy-smoke] no probe URL — set PUBLIC_BASE_URL or SMOKE_BASE_URL",
    );
    return 2;
  }

  console.log(`[post-deploy-smoke] polling ${url} (timeout ${POLL_TIMEOUT_MS}ms)`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastAttempt: ProbeAttempt = {
    status: null,
    body: "",
    error: "no attempt yet",
  };
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    lastAttempt = await probe(url);
    if (lastAttempt.status === 200) {
      console.log(
        `[post-deploy-smoke] ok after ${attempts} attempt(s) ` +
          `(${lastAttempt.body.slice(0, 200)})`,
      );
      return 0;
    }
    console.warn(
      `[post-deploy-smoke] attempt ${attempts}: ` +
        (lastAttempt.error
          ? `error=${lastAttempt.error}`
          : `status=${lastAttempt.status} body=${lastAttempt.body.slice(0, 200)}`),
    );
    if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Failure path: assemble a useful alert body and ship it.
  const summary = lastAttempt.error
    ? `network error: ${lastAttempt.error}`
    : `http ${lastAttempt.status}`;
  const alertBody = [
    `Deep health check failed after deploy.`,
    ``,
    `URL: ${url}`,
    `Attempts: ${attempts}`,
    `Window: ${POLL_TIMEOUT_MS}ms`,
    `Last result: ${summary}`,
    ``,
    `Last response body (truncated):`,
    lastAttempt.body.slice(0, 1500),
    ``,
    `Likely causes: missing column on a modeled table (the original`,
    `2026-04-23 incident shape), DB connectivity loss, or the new`,
    `revision crashed before binding the port.`,
  ].join("\n");

  console.error(`[post-deploy-smoke] FAILED — ${summary}`);
  try {
    const alertResult = await sendOperatorAlert({
      source: "post-deploy-smoke",
      subject: "deep health check failed after deploy",
      body: alertBody,
    });
    if (!alertResult.delivered) {
      console.warn(
        `[post-deploy-smoke] alert not delivered (${alertResult.reason})`,
      );
    }
  } catch (err) {
    // Alerting must never override the underlying signal — even if the
    // alert fails to send, we still want to fail the deploy.
    console.error(
      `[post-deploy-smoke] alert dispatch threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return 1;
}

// Entry-point guard: only auto-run when invoked directly (not when
// imported by the unit test).
const invokedDirectly =
  // tsx sets process.argv[1] to the script path
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("post-deploy-smoke.ts");

if (invokedDirectly) {
  runSmoke()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[post-deploy-smoke] unexpected error:", err);
      process.exit(1);
    });
}
