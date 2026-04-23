/**
 * Coverage for the deep health probe added in Task #125.
 *
 * The probe issues `SELECT * FROM <table> WHERE FALSE` against every
 * Drizzle-modeled table so any column declared in `shared/schema.ts`
 * but absent from the live database surfaces as a 503 — this is the
 * exact failure mode of the 2026-04-23 migration-skip incident.
 *
 * Strategy:
 *  - Happy-path test runs against the real DATABASE_URL and asserts
 *    `status: "ok"` with zero failures (the schema is whole on a
 *    healthy dev DB).
 *  - The "missing column" test acquires a single client from the
 *    pool, opens a transaction, drops `pdf_page_hint` from
 *    `devis_line_items` inside the transaction, runs the probe
 *    against a Drizzle handle bound to that client, then ROLLBACKs
 *    so no schema damage leaks out. This deliberately mirrors the
 *    way `pdf_page_hint` was missing on prod after 0019/0020 silently
 *    skipped.
 *  - Skipped (with a clear log) when DATABASE_URL is unset, matching
 *    the convention used by the migration-replay test (Task #124).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { runDeepHealthCheck, discoverSchemaTables } from "../routes/healthz";
import * as schema from "@shared/schema";

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

const describeIfDb = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn(
    "[healthz-deep.test] DATABASE_URL not set — skipping. Set it locally to run.",
  );
}

describeIfDb("runDeepHealthCheck", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("discovers every PgTable export from shared/schema", () => {
    const tables = discoverSchemaTables();
    // Sanity: at least the two tables involved in the original incident
    // (and the bedrock projects table) must be present. If this list
    // ever shrinks unexpectedly, somebody has weakened the discovery
    // helper and the deep probe will silently shrink with it.
    const names = new Set(tables.map((t) => t.name));
    expect(names.has("projects")).toBe(true);
    expect(names.has("devis")).toBe(true);
    expect(names.has("devis_line_items")).toBe(true);
    expect(tables.length).toBeGreaterThan(20);
  });

  it("returns ok when the schema matches the database", async () => {
    const db = drizzle(pool, { schema });
    const result = await runDeepHealthCheck(db);
    if (result.status !== "ok") {
      // Print the failures so a CI run that hits an unexpectedly
      // broken local DB shows what's wrong rather than just failing
      // an opaque assertion.
      // eslint-disable-next-line no-console
      console.error("[healthz-deep.test] unexpected failures:", result.failures);
    }
    expect(result.status).toBe("ok");
    expect(result.failures).toEqual([]);
    expect(result.checked).toBeGreaterThan(20);
  });

  it("returns degraded with the offending table+column when a column is missing", async () => {
    // Acquire a single client and run the entire scenario inside one
    // transaction so the DROP COLUMN is rolled back before any other
    // connection can see it.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        'ALTER TABLE devis_line_items DROP COLUMN IF EXISTS pdf_page_hint',
      );

      // Drizzle handle bound to THIS client — the deep probe will
      // observe the missing column.
      const dbOnClient = drizzle(client as unknown as pg.Pool, { schema });
      const result = await runDeepHealthCheck(dbOnClient);

      expect(result.status).toBe("degraded");
      const lineItemFailure = result.failures.find(
        (f) => f.table === "devis_line_items",
      );
      expect(lineItemFailure).toBeDefined();
      expect(lineItemFailure!.error).toMatch(/pdf_page_hint/);
      // NOTE: in production each db.select() draws an independent
      // connection from the pool, so a failure on one table does not
      // affect the next. This test runs every probe on a single
      // shared client inside one transaction, so once Postgres aborts
      // the transaction every subsequent table reports
      // "current transaction is aborted". That cascading is a test
      // artifact — not asserted here. The invariant we DO care about
      // is that the first / root cause failure is reported with the
      // offending column name, which is what the deploy gate needs
      // to make the right call.
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
