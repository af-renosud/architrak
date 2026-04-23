/**
 * Migration replay + schema parity gate (Task #124).
 *
 * Provisions a throwaway Postgres database (using the same server as
 * DATABASE_URL points at), replays every migration in `migrations/`
 * against it via the project's own `runMigrationsWith` entrypoint
 * (the same code path used at deploy boot — see server/migrate.ts),
 * and asserts:
 *
 *   1. The number of rows in `drizzle.__drizzle_migrations` after
 *      `runMigrationsWith()` returns equals the number of entries in
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
 * The suite is auto-discovered by vitest (matches the existing
 * `server/__tests__/**\/*.test.ts` include glob in vitest.config.ts)
 * and is also invoked explicitly by `scripts/check-migration-replay.sh`
 * which `scripts/post-merge.sh` runs as a hard pre-deploy gate.
 *
 * Skip behaviour:
 *   - DATABASE_URL unset → describe.skipIf at module scope. (In this
 *     codebase DATABASE_URL is required by server/env.ts so this path
 *     is unreachable at deploy time; pg-mem is not used as a
 *     fallback because Drizzle migrations rely on Postgres-specific
 *     features pg-mem does not implement, e.g. partial unique
 *     indexes with WHERE clauses on devis_check_tokens.)
 *   - Server denies CREATE DATABASE → testContext.skip() inside each
 *     it() so the runner reports a real skipped state. The boot-time
 *     assertion (Task #123) remains the authoritative gate when this
 *     happens.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@shared/schema";
import { runMigrationsWith } from "../migrate";
import { assertSchemaMatchesTracker } from "../operations/schema-presence-check";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "..", "..", "migrations");

const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
const journal = fs.existsSync(journalPath)
  ? (JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
      entries?: Array<{ tag: string; when: number }>;
    })
  : { entries: [] as Array<{ tag: string; when: number }> };
const journalEntryCount: number = journal.entries?.length ?? 0;

/**
 * The "admin" connection is just any database we can connect to in
 * order to issue CREATE / DROP DATABASE for the throwaway replay DB
 * (Postgres forbids those statements against the database you're
 * currently connected to). We default to the same database
 * DATABASE_URL already points at — that's the most portable choice
 * because we know the role can connect there. Operators who run a
 * stricter setup can override via REPLAY_ADMIN_DB (e.g. "postgres",
 * "template1") if their main DB role can't issue CREATE DATABASE.
 */
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
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Discover every PgTable instance exported from shared/schema.ts.
 * Robust against drizzle internals: try `getTableConfig` on each
 * export and skip values that aren't tables.
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
  adminPool?: pg.Pool;
  replayPool?: pg.Pool;
  replayDbName?: string;
  skipReason: string | null;
}

const ctx: ReplayContext = { skipReason: null };

const STRICT = process.env.STRICT_MIGRATION_REPLAY === "1";
const skipModule =
  !DATABASE_URL && !STRICT ? "DATABASE_URL is not set" : null;

if (!DATABASE_URL && STRICT) {
  // STRICT mode (set by scripts/check-migration-replay.sh in the
  // post-merge gate) — refuse to silently skip when the environment
  // can't actually run the gate.
  throw new Error(
    "[migration-replay] STRICT_MIGRATION_REPLAY=1 but DATABASE_URL is not set — cannot run pre-deploy gate",
  );
}

describe.skipIf(skipModule !== null)("migration replay + schema parity", () => {
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
    } catch (err) {
      ctx.skipReason = `cannot CREATE DATABASE on this server: ${errMessage(err)}`;
      if (STRICT) {
        // Hard-fail in the post-merge gate so privilege/config drift
        // can't silently disable the check. Surface the underlying
        // error so the operator can fix the permission immediately.
        throw new Error(
          `[migration-replay] STRICT mode: ${ctx.skipReason}. Grant CREATE DATABASE on the deploy DB role or run this gate against an admin-capable Postgres.`,
        );
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[migration-replay] SKIPPED — ${ctx.skipReason}. The boot-time assertion (Task #123) remains authoritative for this environment.`,
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
          await ctx.adminPool.query(`DROP DATABASE IF EXISTS "${ctx.replayDbName}"`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[migration-replay] cleanup warning: ${errMessage(err)}`);
      } finally {
        await ctx.adminPool.end();
      }
    }
  }, 30_000);

  it("replays every migration via runMigrationsWith and the tracker row count equals the journal entry count", async (testContext) => {
    if (ctx.skipReason || !ctx.replayPool) {
      testContext.skip();
      return;
    }
    expect(journalEntryCount).toBeGreaterThan(0);

    await runMigrationsWith({
      pool: ctx.replayPool,
      migrationsFolder,
    });

    const tracker = await ctx.replayPool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM drizzle.__drizzle_migrations`,
    );
    const trackerCount = Number(tracker.rows[0]?.c ?? "0");

    expect(
      trackerCount,
      `journal entries: ${journalEntryCount}, applied (tracker rows): ${trackerCount} — silent partial-apply detected`,
    ).toBe(journalEntryCount);
  }, 120_000);

  it("schema-presence invariant agrees with the tracker on the replayed database (Task #136)", async (testContext) => {
    if (ctx.skipReason || !ctx.replayPool) {
      testContext.skip();
      return;
    }
    // After a clean replay, every journal entry has a tracker row and
    // every artifact in MIGRATION_ARTIFACTS exists. The assertion
    // throws on any drift; we just expect it not to throw here.
    await expect(
      assertSchemaMatchesTracker({
        pool: ctx.replayPool,
        migrationsFolder,
      }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("every column declared in shared/schema.ts exists on the replayed database", async (testContext) => {
    if (ctx.skipReason || !ctx.replayPool) {
      testContext.skip();
      return;
    }

    const tables = discoverTables();
    expect(
      tables.length,
      `expected to discover >30 Drizzle tables in shared/schema.ts; got ${tables.length}`,
    ).toBeGreaterThan(30);

    const failures: Array<{ table: string; error: string }> = [];

    for (const table of tables) {
      const cfg = getTableConfig(table);
      if (cfg.schema && cfg.schema !== "public") continue;
      if (cfg.columns.length === 0) continue;

      const colList = cfg.columns.map((c) => `"${c.name}"`).join(", ");
      const sql = `SELECT ${colList} FROM "${cfg.name}" LIMIT 0`;
      try {
        await ctx.replayPool.query(sql);
      } catch (err) {
        failures.push({
          table: cfg.name,
          error: errMessage(err),
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
