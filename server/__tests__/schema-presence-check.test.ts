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
