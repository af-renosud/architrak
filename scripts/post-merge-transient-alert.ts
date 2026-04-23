#!/usr/bin/env tsx
/**
 * Tiny wrapper script invoked by `scripts/lib/run-or-classify.sh`
 * (Task #126) when a post-merge maintenance script exits non-zero
 * WITHOUT a schema-error fingerprint. Sends one operator alert with
 * the `[transient]` subject prefix and exits 0 regardless of whether
 * the alert actually delivered — the deploy must continue.
 *
 * Args: <source-tag> <body>
 */
import { sendOperatorAlert } from "../server/operations/operator-alerts";

async function main() {
  const [, , source, body] = process.argv;
  if (!source || !body) {
    console.error(
      "[post-merge-transient-alert] usage: post-merge-transient-alert <source> <body>",
    );
    process.exit(0); // never block the deploy on bad invocation
  }
  try {
    const result = await sendOperatorAlert({
      source,
      // The `[transient]` prefix tells the on-call to treat this as
      // informational rather than a P0 — distinguishes from the
      // schemaError path which aborts the deploy entirely.
      subject: `[transient] ${source} exited non-zero during post-merge`,
      body,
    });
    if (!result.delivered) {
      console.warn(
        `[post-merge-transient-alert] alert not delivered (${result.reason})`,
      );
    }
  } catch (err) {
    console.error(
      `[post-merge-transient-alert] dispatch threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.exit(0);
}

main();
