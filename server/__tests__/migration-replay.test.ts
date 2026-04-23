/**
 * Migration replay + schema parity gate (Task #124).
 *
 * Provisions a throwaway Postgres database (using the same server as
 * DATABASE_URL points at), replays every migration from `migrations/`
 * against it, and asserts:
 *
 *   1. The number of rows in `drizzle.__drizzle_migrations` after
 *      `migrate()` returns equals the number of entries in
 *      `migrations/meta/_journal.json`. This catches the silent
 *      partial-apply class of bug that produced the pdf_page_hint
 *      production incident on 2026-04-23 — `migrate()` claimed `done`
 *      while only applying 4 of the 6 pending migrations.
 *
 *   2. For every Drizzle table declared in `shared/schema.ts`, a
 *      `SELECT <every column> FROM <table> LIMIT 0` succeeds against
 *      the replayed schema. Postgres throws `column "<x>" does not
 *      exist` if any modeled column is absent, naming the offending
 *      column in the error.
 *
 * The whole suite is auto-discovered by vitest (matches the existing
 * `server/__tests__/**\/*.test.ts` include glob in vitest.config.ts) —
 * no package.json wiring required.
 *
 * The suite is skipped when DATABASE_URL is unset (e.g. on
 * environments without a Postgres). When the database server denies
 * CREATE DATABASE, the suite is also skipped with a one-line warning
 * so it doesn't block local runs on managed services that lock the
 * permission down — the same gate must then be enforced by the
 * boot-time assertion (Task #123) and by CI's own ephemeral PG.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@shared/schema";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "..", "..", "migrations");

const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
const journal = fs.existsSync(journalPath)
  ? JSON.parse(fs.readFileSync(journalPath, "utf-8"))
  : { entries: [] };
const journalEntryCount: number = journal.entries?.length ?? 0;

function buildAdminUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  u.pathname = "/postgres";
  return u.toString();
}

function buildReplayUrl(databaseUrl: string, dbName: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Discover every PgTable instance exported from shared/schema.ts.
 * We try `getTableConfig` on each export and skip values that aren't
 * tables — this is more robust than brand-checks against drizzle
 * internals.
 */
function discoverTables(): PgTable[] {
  const tables: PgTable[] = [];
  for (const value of Object.values(schema)) {
    if (value == null || typeof value !== "object") continue;
    try {
      getTableConfig(value as PgTable);
      tables.push(value as PgTable);
    } catch {
      // not a PgTable
    }
  }
  return tables;
}

interface ReplayContext {
  adminPool: pg.Pool;
  replayPool: pg.Pool;
  replayDbName: string;
  skipReason: string | null;
}

const ctx: ReplayContext = {
  adminPool: null as unknown as pg.Pool,
  replayPool: null as unknown as pg.Pool,
  replayDbName: "",
  skipReason: null,
};

const skipReason = !DATABASE_URL ? "DATABASE_URL is not set" : null;

describe.skipIf(skipReason !== null)("migration replay + schema parity", () => {
  beforeAll(async () => {
    if (!DATABASE_URL) return;
    ctx.adminPool = new Pool({
      connectionString: buildAdminUrl(DATABASE_URL),
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });

    ctx.replayDbName = `migration_replay_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    try {
      await ctx.adminPool.query(`CREATE DATABASE "${ctx.replayDbName}"`);
    } catch (e: any) {
      ctx.skipReason = `cannot CREATE DATABASE on this server: ${e?.message ?? e}`;
      // eslint-disable-next-line no-console
      console.warn(
        `[migration-replay] SKIPPED — ${ctx.skipReason}. The boot-time assertion (Task #123) and CI's own ephemeral PG remain authoritative.`,
      );
      return;
    }

    ctx.replayPool = new Pool({
      connectionString: buildReplayUrl(DATABASE_URL, ctx.replayDbName),
      max: 4,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await ctx.replayPool?.end();
    } catch {
      // ignore
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
          await ctx.adminPool.query(`DROP DATABASE IF EXISTS "${ctx.replayDbName}"`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[migration-replay] cleanup warning: ${(e as Error).message}`);
      } finally {
        await ctx.adminPool.end();
      }
    }
  }, 30_000);

  it("replays every migration and the tracker row count equals the journal entry count", async (testContext) => {
    if (ctx.skipReason) {
      testContext.skip();
      return;
    }
    expect(journalEntryCount).toBeGreaterThan(0);
    expect(ctx.replayPool, "replay pool was not initialised").toBeDefined();

    const replayDb = drizzle(ctx.replayPool);
    await migrate(replayDb, { migrationsFolder });

    const tracker = await ctx.replayPool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM drizzle.__drizzle_migrations`,
    );
    const trackerCount = Number(tracker.rows[0]?.c ?? "0");

    expect(
      trackerCount,
      `journal entries: ${journalEntryCount}, applied (tracker rows): ${trackerCount} — silent partial-apply detected`,
    ).toBe(journalEntryCount);
  }, 120_000);

  it("every column declared in shared/schema.ts exists on the replayed database", async (testContext) => {
    if (ctx.skipReason) {
      testContext.skip();
      return;
    }
    expect(ctx.replayPool, "replay pool was not initialised").toBeDefined();

    const tables = discoverTables();
    expect(
      tables.length,
      "expected to discover >30 Drizzle tables in shared/schema.ts; got " + tables.length,
    ).toBeGreaterThan(30);

    const failures: Array<{ table: string; error: string }> = [];

    for (const table of tables) {
      const cfg = getTableConfig(table);
      // Skip tables in non-public schemas (we don't probe drizzle's
      // own bookkeeping schema, etc.).
      if (cfg.schema && cfg.schema !== "public") continue;
      if (cfg.columns.length === 0) continue;

      const colList = cfg.columns.map((c) => `"${c.name}"`).join(", ");
      const sql = `SELECT ${colList} FROM "${cfg.name}" LIMIT 0`;
      try {
        await ctx.replayPool.query(sql);
      } catch (e) {
        failures.push({
          table: cfg.name,
          error: (e as Error)?.message ?? String(e),
        });
      }
    }

    if (failures.length > 0) {
      const detail = failures
        .map((f) => `  - ${f.table}: ${f.error}`)
        .join("\n");
      throw new Error(
        `schema parity failed for ${failures.length} table(s) — Drizzle schema declares columns the replayed migrations did not produce:\n${detail}`,
      );
    }
  }, 60_000);
});
