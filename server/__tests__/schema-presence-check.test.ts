/**
 * Tests for server/operations/schema-presence-check.ts (Task #136).
 *
 * Provisions a throwaway Postgres database (same pattern as
 * migration-replay.test.ts and reconcile-drizzle-tracker.test.ts),
 * replays every migration via runMigrationsWith to land a known-good
 * schema + tracker, then mutates one or the other to synthesize the
 * three states the invariant must catch:
 *
 *   1. all good                   → no throw
 *   2. tracker says applied
 *      but the artifact is gone   → throw naming the tag + artifact
 *   3. artifact present but the
 *      tracker has no row for it  → throw naming the tag + artifact
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrationsWith } from "../migrate";
import {
  assertSchemaMatchesTracker,
  MIGRATION_ARTIFACTS,
} from "../operations/schema-presence-check";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "..", "..", "migrations");

function buildAdminUrl(databaseUrl: string): string {
  const override = process.env.REPLAY_ADMIN_DB;
  if (!override) return databaseUrl;
  const u = new URL(databaseUrl);
  u.pathname = `/${override}`;
  return u.toString();
}

function buildReplayUrl(databaseUrl: string, dbName: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


interface Ctx {
  adminPool?: pg.Pool;
  replayPool?: pg.Pool;
  replayDbName?: string;
  skipReason: string | null;
}
const ctx: Ctx = { skipReason: null };

const skipModule = !DATABASE_URL ? "DATABASE_URL is not set" : null;

describe.skipIf(skipModule !== null)("schema-presence check (Task #136)", () => {
  beforeAll(async () => {
    if (!DATABASE_URL) return;
    ctx.adminPool = new Pool({
      connectionString: buildAdminUrl(DATABASE_URL),
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });

    ctx.replayDbName = `schema_presence_test_${Date.now()}_${Math.floor(
      Math.random() * 1e6,
    )}`;
    try {
      await ctx.adminPool.query(`CREATE DATABASE "${ctx.replayDbName}"`);
    } catch (err) {
      ctx.skipReason = `cannot CREATE DATABASE on this server: ${errMessage(err)}`;
      // eslint-disable-next-line no-console
      console.warn(`[schema-presence-test] SKIPPED — ${ctx.skipReason}`);
      return;
    }

    ctx.replayPool = new Pool({
      connectionString: buildReplayUrl(DATABASE_URL, ctx.replayDbName),
      max: 4,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });

    // Land a known-good schema + tracker by replaying every
    // migration. runMigrationsWith already calls
    // assertSchemaMatchesTracker at the end; if the seed itself
    // throws, the test fails loudly — exactly what we want.
    await runMigrationsWith({
      pool: ctx.replayPool,
      migrationsFolder,
    });
  }, 120_000);

  afterAll(async () => {
    if (ctx.replayPool) {
      try {
        await ctx.replayPool.end();
      } catch {
        // ignore
      }
    }
    if (ctx.adminPool) {
      try {
        if (ctx.replayDbName) {
          await ctx.adminPool.query(
            `SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
              WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [ctx.replayDbName],
          );
          await ctx.adminPool.query(
            `DROP DATABASE IF EXISTS "${ctx.replayDbName}"`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[schema-presence-test] cleanup warning: ${errMessage(err)}`,
        );
      } finally {
        await ctx.adminPool.end();
      }
    }
  }, 30_000);

  it("passes on a freshly-replayed schema (all good)", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    await expect(
      assertSchemaMatchesTracker({
        pool: ctx.replayPool,
        migrationsFolder,
      }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("throws when tracker says applied but the artifact is missing", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    // 0019 added devis_line_items.pdf_page_hint. Drop it: the tracker
    // still has the hash, the column is gone — exactly the inverse-of-
    // 2026-04-23 scenario this invariant exists to catch.
    await ctx.replayPool.query(
      `ALTER TABLE "devis_line_items" DROP COLUMN "pdf_page_hint"`,
    );

    try {
      await expect(
        assertSchemaMatchesTracker({
          pool: ctx.replayPool,
          migrationsFolder,
        }),
      ).rejects.toThrow(/0019_numerous_drax.*pdf_page_hint/);
    } finally {
      // Restore so the next test starts from a known-good baseline.
      await ctx.replayPool.query(
        `ALTER TABLE "devis_line_items" ADD COLUMN "pdf_page_hint" integer`,
      );
    }
  }, 60_000);

  it("self-heals when artifact exists but the tracker has no row for it", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    // Delete the tracker row for 0020 (pdf_bbox column). The column
    // is still present; the tracker now disagrees. This is the
    // "tracker behind, schema forward" drift — the recoverable
    // direction: assertSchemaMatchesTracker now self-heals it via
    // reconcileTracker instead of aborting boot. Match by created_at
    // because that's the journal's stable identifier.
    const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const entry = journal.entries.find(
      (e) => e.tag === "0020_per_line_pdf_bbox",
    );
    if (!entry) throw new Error("0020 missing from journal");

    const del = await ctx.replayPool.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [entry.when],
    );
    expect(del.rowCount).toBe(1);

    await expect(
      assertSchemaMatchesTracker({
        pool: ctx.replayPool,
        migrationsFolder,
      }),
    ).resolves.toBeUndefined();

    // The self-heal must have re-inserted exactly the missing row —
    // no duplicates, tracker back in sync with the journal.
    const restored = await ctx.replayPool.query(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [entry.when],
    );
    expect(restored.rows[0].n).toBe(1);
    const total = await ctx.replayPool.query(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(total.rows[0].n).toBe(journal.entries.length);
  }, 60_000);

  it("runMigrationsWith self-heals a tracker-behind drift BEFORE drizzle migrate(), avoiding `column already exists`", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    // Simulate the production drift: schema fully forward, tracker
    // missing the row for 0019. 0019's SQL is `ALTER TABLE
    // devis_line_items ADD COLUMN pdf_page_hint integer` (NO IF NOT
    // EXISTS) — if the schema-presence check ran AFTER migrate(),
    // drizzle would crash with `column "pdf_page_hint" already
    // exists`. The pre-migrate check must self-heal the tracker so
    // migrate() never re-runs 0019.
    const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === "0019_numerous_drax")!;

    await ctx.replayPool.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [entry.when],
    );

    let caught: Error | null = null;
    try {
      await runMigrationsWith({
        pool: ctx.replayPool,
        migrationsFolder,
      });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }

    // Drizzle's native duplicate-column error reads like:
    //   `column "pdf_page_hint" of relation "devis_line_items" already exists`
    // — a clean run proves the pre-migrate self-heal restored the
    // tracker before drizzle could re-run 0019.
    expect(caught).toBeNull();
    const restored = await ctx.replayPool.query(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [entry.when],
    );
    expect(restored.rows[0].n).toBe(1);
    const total = await ctx.replayPool.query(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(total.rows[0].n).toBe(journal.entries.length);
  }, 60_000);

  it("self-heal EXECUTES pending data-only migrations instead of just stamping them (Task #561)", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    // Reproduce the production incident: tracker is missing BOTH a
    // schema migration whose artifact is present (0020 → triggers the
    // self-heal) AND a pending data-only migration (0094, the certificat
    // backfill). The old behavior blanket-inserted 0094's tracker row
    // without running its UPDATE, silently swallowing the repair. The
    // fixed self-heal must execute 0094's SQL before reconciling.
    const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const schemaEntry = journal.entries.find((e) => e.tag === "0020_per_line_pdf_bbox")!;
    const dataOnlyEntry = journal.entries.find(
      (e) => e.tag === "0094_backfill_certificat_sent_status",
    )!;

    for (const e of [schemaEntry, dataOnlyEntry]) {
      const del = await ctx.replayPool.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [e.when],
      );
      expect(del.rowCount).toBe(1);
    }

    // Seed a stale certificat exactly like prod C1: status 'ready' with
    // a sent certificat_sent communication.
    const proj = await ctx.replayPool.query<{ id: number }>(
      `INSERT INTO projects (name, code, client_name) VALUES ('T561', 'T561-${Date.now()}', 'T561') RETURNING id`,
    );
    const contractor = await ctx.replayPool.query<{ id: number }>(
      `INSERT INTO contractors (name) VALUES ('T561') RETURNING id`,
    );
    const cert = await ctx.replayPool.query<{ id: number }>(
      `INSERT INTO certificats (project_id, contractor_id, certificate_ref, total_works_ht, net_to_pay_ht, tva_amount, net_to_pay_ttc, status)
       VALUES ($1, $2, 'T561-C1', '100.00', '100.00', '20.00', '120.00', 'ready') RETURNING id`,
      [proj.rows[0].id, contractor.rows[0].id],
    );
    await ctx.replayPool.query(
      `INSERT INTO project_communications (project_id, type, recipient_type, subject, status, related_certificat_id)
       VALUES ($1, 'certificat_sent', 'client', 'T561', 'sent', $2)`,
      [proj.rows[0].id, cert.rows[0].id],
    );

    await expect(
      assertSchemaMatchesTracker({
        pool: ctx.replayPool,
        migrationsFolder,
      }),
    ).resolves.toBeUndefined();

    // The data-only UPDATE must actually have run — the stale
    // certificat is now 'sent', not merely tracker-stamped.
    const after = await ctx.replayPool.query<{ status: string; version: number }>(
      `SELECT status, version FROM certificats WHERE id = $1`,
      [cert.rows[0].id],
    );
    expect(after.rows[0].status).toBe("sent");

    // And the tracker is back in full sync.
    const total = await ctx.replayPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(total.rows[0].n).toBe(journal.entries.length);

    // Cleanup seeds so later replay assertions aren't polluted.
    await ctx.replayPool.query(`DELETE FROM project_communications WHERE project_id = $1`, [proj.rows[0].id]);
    await ctx.replayPool.query(`DELETE FROM certificats WHERE id = $1`, [cert.rows[0].id]);
    await ctx.replayPool.query(`DELETE FROM projects WHERE id = $1`, [proj.rows[0].id]);
    await ctx.replayPool.query(`DELETE FROM contractors WHERE id = $1`, [contractor.rows[0].id]);
  }, 60_000);

  it("self-heal does NOT execute non-rerunnable data-only migrations — stamp-only (Task #561)", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    // 0079_certificat_status_check is data_only WITHOUT the rerunnable
    // flag: its SQL is an unguarded ADD CONSTRAINT that already applied.
    // If the self-heal tried to execute it again the whole recovery
    // would FATAL with "constraint already exists". Deleting its
    // tracker row alongside a schema migration's must still self-heal
    // cleanly by stamping only.
    const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const schemaEntry = journal.entries.find((e) => e.tag === "0020_per_line_pdf_bbox")!;
    const nonRerunnable = journal.entries.find((e) => e.tag === "0079_certificat_status_check")!;

    for (const e of [schemaEntry, nonRerunnable]) {
      const del = await ctx.replayPool.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
        [e.when],
      );
      expect(del.rowCount).toBe(1);
    }

    await expect(
      assertSchemaMatchesTracker({
        pool: ctx.replayPool,
        migrationsFolder,
      }),
    ).resolves.toBeUndefined();

    const total = await ctx.replayPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(total.rows[0].n).toBe(journal.entries.length);
  }, 60_000);

  it("MIGRATION_ARTIFACTS covers every journal entry exactly once", () => {
    const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
      entries: Array<{ tag: string }>;
    };
    const tags = journal.entries.map((e) => e.tag).sort();
    const covered = MIGRATION_ARTIFACTS.map((m) => m.tag).sort();
    expect(covered).toEqual(tags);
    // No duplicates.
    expect(new Set(covered).size).toBe(covered.length);
  });
});
