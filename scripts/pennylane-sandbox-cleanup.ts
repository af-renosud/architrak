/**
 * Pennylane sandbox cleanup (Task #214 phase G3).
 *
 * After a sandbox dry-run / live-test session, this script:
 *
 *   1. Lists every customer in Pennylane whose external_id begins
 *      with `architrak:client:project:` and deletes them (which
 *      cascades the related customer_invoices on the Pennylane side).
 *   2. Clears the local mirror columns so a fresh re-push starts
 *      from a clean slate:
 *        - projects.pennylane_customer_id      → null
 *        - fee_entries.pennylane_invoice_id    → null
 *        - fee_entries.pennylane_pdf_storage_key → null (no GCS delete)
 *        - fee_entries.pennylane_pushed_at     → null
 *        - fee_entries.pennylane_paid_at       → null
 *        - fee_entries.pennylane_paid_amount   → null
 *        - fee_entries.pennylane_status        → null
 *   3. Deletes every row in `pennylane_pushes`.
 *
 * Safety rails:
 *   - REFUSES to run unless PENNYLANE_BASE_URL points at a sandbox
 *     host (matches `/sandbox|staging|test/`). Production hostnames
 *     trigger a hard exit before any API call is made.
 *   - Requires --confirm flag.
 *
 * Usage:
 *   PENNYLANE_BASE_URL=https://app.sandbox.pennylane.com/api/external/v2 \
 *   PENNYLANE_API_KEY=... \
 *   npx tsx scripts/pennylane-sandbox-cleanup.ts --confirm
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";
import {
  iteratePages,
  isPennylaneConfigured,
  pennylaneRequest,
  PennylaneApiError,
} from "../server/services/pennylane/client";
import { env } from "../server/env";

/**
 * Strict, explicit hostname allowlist. We parse the URL and compare
 * the *hostname* (case-insensitive, exact match) against a closed
 * set of known Pennylane sandbox hosts. No regex substring or suffix
 * match is used — that would let attacker-crafted hostnames like
 * `test.pennylane.com.evil.com` slip through. To add a host, append
 * it here and add a corresponding unit test.
 */
const SANDBOX_HOSTNAME_ALLOWLIST: ReadonlySet<string> = new Set([
  "app.sandbox.pennylane.com",
  "sandbox.pennylane.com",
  "staging.pennylane.com",
  "app.staging.pennylane.com",
  "test.pennylane.com",
  "sbx.pennylane.com",
]);

export function isSandboxBaseUrl(
  rawUrl: string,
): { ok: true; host: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `PENNYLANE_BASE_URL "${rawUrl}" is not a valid URL` };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol "${parsed.protocol}" — https only` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!SANDBOX_HOSTNAME_ALLOWLIST.has(host)) {
    return {
      ok: false,
      reason: `hostname "${parsed.hostname}" is not in the sandbox allowlist — refusing to touch this tenant`,
    };
  }
  return { ok: true, host };
}

interface PennylaneCustomer {
  id?: number | string;
  external_id?: string;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm")) {
    console.error("Refusing to run without --confirm.");
    process.exit(1);
  }
  if (!isPennylaneConfigured()) {
    console.error("PENNYLANE_API_KEY not set.");
    process.exit(1);
  }
  const guard = isSandboxBaseUrl(env.PENNYLANE_BASE_URL);
  if (!guard.ok) {
    console.error(`Refusing to run — ${guard.reason}.`);
    console.error(
      `Update PENNYLANE_BASE_URL to a sandbox/staging/test host and re-run, or do not run this script.`,
    );
    process.exit(2);
  }

  console.log(`[cleanup] Sandbox host accepted: ${guard.host}`);

  // Step 1 — delete every architrak-tagged customer on Pennylane.
  let deletedRemote = 0;
  let scannedRemote = 0;
  for await (const page of iteratePages<PennylaneCustomer>("/customers", { per_page: 100 })) {
    for (const cust of page) {
      scannedRemote += 1;
      if (!cust.external_id?.startsWith("architrak:client:project:")) continue;
      const id = cust.id;
      if (id === undefined || id === null) continue;
      try {
        await pennylaneRequest({ method: "DELETE", path: `/customers/${id}` });
        deletedRemote += 1;
        console.log(`[cleanup] deleted customer ${id} (${cust.external_id})`);
      } catch (err) {
        const status = err instanceof PennylaneApiError ? err.status : "?";
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[cleanup] delete failed for customer ${id} (status=${status}): ${msg}`);
      }
    }
  }
  console.log(`[cleanup] remote scan complete — scanned=${scannedRemote} deleted=${deletedRemote}`);

  // Step 2 — clear local mirror columns.
  const projectClear = await db.execute(
    sql`UPDATE projects SET pennylane_customer_id = NULL WHERE pennylane_customer_id IS NOT NULL`,
  );
  const feeClear = await db.execute(
    sql`UPDATE fee_entries
        SET pennylane_invoice_id = NULL,
            pennylane_pdf_storage_key = NULL,
            pennylane_pushed_at = NULL,
            pennylane_paid_at = NULL,
            pennylane_paid_amount = NULL,
            pennylane_status = NULL
        WHERE pennylane_invoice_id IS NOT NULL
           OR pennylane_pdf_storage_key IS NOT NULL
           OR pennylane_pushed_at IS NOT NULL
           OR pennylane_paid_at IS NOT NULL
           OR pennylane_paid_amount IS NOT NULL
           OR pennylane_status IS NOT NULL`,
  );
  const queueClear = await db.execute(sql`DELETE FROM pennylane_pushes`);

  console.log(
    `[cleanup] local mirror cleared — projects=${projectClear.rowCount ?? "?"} fee_entries=${feeClear.rowCount ?? "?"} queue=${queueClear.rowCount ?? "?"}`,
  );
}

// Only execute when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1]?.endsWith("pennylane-sandbox-cleanup.ts");

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[cleanup] crashed:", err);
      process.exit(1);
    });
}
