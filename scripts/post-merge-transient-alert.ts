#!/usr/bin/env tsx
/**
 * Wrapper invoked by `scripts/lib/run-or-classify.sh` (Task #126/#130) to
 * dispatch operator alerts AND maintain the consecutive-failure counter that
 * drives `[transient]` → `[escalated]` escalation.
 *
 * Subcommands:
 *   record <source> <exitCode> <body>
 *     Persist the transient failure (Task #130 counter table) and send one
 *     operator alert. Subject prefix flips from `[transient]` to `[escalated]`
 *     once the source has failed on POST_MERGE_ESCALATE_AFTER consecutive
 *     deploys (default 3). Failure to persist degrades to a plain
 *     `[transient]` alert — we never abort the deploy on alert-plumbing
 *     failure.
 *
 *   clear <source>
 *     Reset the consecutive-failure counter for `source` after a successful
 *     run. No alert. Safe to call when no row exists.
 *
 * Always exits 0 so the deploy continues regardless of alert/persistence
 * outcomes.
 */
import { sendOperatorAlert } from "../server/operations/operator-alerts";
import {
  recordTransientFailure,
  clearTransientFailures,
  formatEscalationHistory,
  parseEscalateAfter,
} from "../server/operations/post-merge-failure-tracker";

function usage(): never {
  console.error(
    "[post-merge-transient-alert] usage: post-merge-transient-alert " +
      "record <source> <exitCode> <body>  |  clear <source>",
  );
  process.exit(0);
}

async function runRecord(source: string, exitCodeArg: string, body: string) {
  const exitCode = Number.parseInt(exitCodeArg, 10);
  const safeExitCode = Number.isFinite(exitCode) ? exitCode : 1;
  const escalateAfter = parseEscalateAfter(process.env.POST_MERGE_ESCALATE_AFTER);

  // Persist the failure first so the subject prefix reflects the up-to-date
  // counter. On DB failure (e.g. table missing on a brand-new env), degrade
  // to the legacy `[transient]` flow rather than dropping the alert entirely.
  let escalated = false;
  let consecutiveFailures = 1;
  let historySection = "";
  try {
    const result = await recordTransientFailure(
      source,
      safeExitCode,
      body,
      escalateAfter,
    );
    escalated = result.escalated;
    consecutiveFailures = result.consecutiveFailures;
    if (escalated) {
      historySection = formatEscalationHistory(result.recentFailures);
    }
  } catch (err) {
    console.error(
      `[post-merge-transient-alert] failed to persist failure counter: ${
        err instanceof Error ? err.message : String(err)
      } — falling back to plain [transient] alert`,
    );
  }

  const prefix = escalated ? "[escalated]" : "[transient]";
  const subject = escalated
    ? `${source} has failed transiently on ${consecutiveFailures} consecutive deploys (> ${escalateAfter})`
    : `${source} exited non-zero during post-merge`;

  const fullBody = escalated && historySection.length > 0
    ? `${body}\n\n---\n${historySection}\n\nThreshold: escalate after more than ${escalateAfter} consecutive transient failures (POST_MERGE_ESCALATE_AFTER).\nA successful run of \`${source}\` on the next deploy will reset the counter automatically.`
    : body;

  try {
    const result = await sendOperatorAlert({
      source,
      subject: `${prefix} ${subject}`,
      body: fullBody,
    });
    if (!result.delivered) {
      console.warn(
        `[post-merge-transient-alert] alert not delivered (${result.reason})`,
      );
    }
  } catch (err) {
    console.error(
      `[post-merge-transient-alert] dispatch threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function runClear(source: string) {
  try {
    const { previousConsecutiveFailures } = await clearTransientFailures(source);
    if (previousConsecutiveFailures > 0) {
      console.log(
        `[post-merge-transient-alert] cleared ${source} consecutive-failure counter ` +
          `(was ${previousConsecutiveFailures})`,
      );
    }
  } catch (err) {
    // Never block the deploy on a clear failure — the worst case is one
    // spurious escalation on the next failure, which is recoverable.
    console.error(
      `[post-merge-transient-alert] failed to clear counter for ${source}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function main() {
  const [, , subcommand, ...rest] = process.argv;
  if (!subcommand) usage();

  if (subcommand === "record") {
    const [source, exitCodeArg, body] = rest;
    if (!source || !exitCodeArg || !body) usage();
    await runRecord(source, exitCodeArg, body);
  } else if (subcommand === "clear") {
    const [source] = rest;
    if (!source) usage();
    await runClear(source);
  } else {
    usage();
  }
  process.exit(0);
}

main();
