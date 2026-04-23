/**
 * Tests for scripts/reconcile-drizzle-tracker.ts (Task #135).
 *
 * Provisions a throwaway Postgres database (same pattern as
 * migration-replay.test.ts), seeds the drizzle.__drizzle_migrations
 * tracker with only the FIRST N journal entries to simulate the
 * "tracker behind, schema fully forward" production drift, runs the
 * reconciler, and asserts the missing rows land with the right hashes
 * and created_at values.
 *
 * Also covers:
 *   - dry-run-by-default (no writes happen without apply)
 *   - idempotent second run (zero diff, exit 0)
 *   - refusal to proceed when tracker contains hashes not in the journal
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileTracker } from "../../scripts/reconcile-drizzle-tracker";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "..", "..", "migrations");
const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
const journal = fs.existsSync(journalPath)
  ? (JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
      entries: Array<{ tag: string; when: number }>;
    })
  : { entries: [] as Array<{ tag: string; when: number }> };

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

function hashOf(tag: string): string {
  const sql = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`)).toString();
  return crypto.createHash("sha256").update(sql).digest("hex");
}

interface Ctx {
  adminPool?: pg.Pool;
  replayPool?: pg.Pool;
  replayDbName?: string;
  skipReason: string | null;
}
const ctx: Ctx = { skipReason: null };

async function seedTrackerWithFirstN(pool: pg.Pool, n: number): Promise<void> {
  const sortedJournal = journal.entries
    .slice()
    .sort((a, b) => a.when - b.when);
  const first = sortedJournal.slice(0, n);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  await pool.query(`TRUNCATE TABLE drizzle.__drizzle_migrations RESTART IDENTITY`);
  for (const e of first) {
    await pool.query(
      `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)`,
      [hashOf(e.tag), e.when],
    );
  }
}

const skipModule = !DATABASE_URL ? "DATABASE_URL is not set" : null;

describe.skipIf(skipModule !== null)("reconcile-drizzle-tracker", () => {
  beforeAll(async () => {
    if (!DATABASE_URL) return;
    ctx.adminPool = new Pool({
      connectionString: buildAdminUrl(DATABASE_URL),
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });

    ctx.replayDbName = `reconcile_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    try {
      await ctx.adminPool.query(`CREATE DATABASE "${ctx.replayDbName}"`);
    } catch (err) {
      ctx.skipReason = `cannot CREATE DATABASE on this server: ${errMessage(err)}`;
      // eslint-disable-next-line no-console
      console.warn(`[reconcile-test] SKIPPED — ${ctx.skipReason}`);
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
          await ctx.adminPool.query(
            `DROP DATABASE IF EXISTS "${ctx.replayDbName}"`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[reconcile-test] cleanup warning: ${errMessage(err)}`);
      } finally {
        await ctx.adminPool.end();
      }
    }
  }, 30_000);

  it("dry-run does not write any rows but reports the diff", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    const seedCount = Math.max(1, journal.entries.length - 8);
    await seedTrackerWithFirstN(ctx.replayPool, seedCount);

    const result = await reconcileTracker({
      pool: ctx.replayPool,
      migrationsFolder,
      apply: false,
      log: () => {},
    });

    expect(result.applied).toBe(false);
    expect(result.journalCount).toBe(journal.entries.length);
    expect(result.trackerCountBefore).toBe(seedCount);
    expect(result.trackerCountAfter).toBe(seedCount);
    expect(result.toInsert.length).toBe(journal.entries.length - seedCount);

    const after = await ctx.replayPool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(after.rows[0]?.c ?? "0")).toBe(seedCount);
  }, 60_000);

  it("apply mode inserts the missing rows with correct hash + created_at", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    const seedCount = Math.max(1, journal.entries.length - 8);
    await seedTrackerWithFirstN(ctx.replayPool, seedCount);

    const result = await reconcileTracker({
      pool: ctx.replayPool,
      migrationsFolder,
      apply: true,
      log: () => {},
    });

    expect(result.applied).toBe(true);
    expect(result.trackerCountAfter).toBe(journal.entries.length);
    expect(result.toInsert.length).toBe(journal.entries.length - seedCount);

    // Every journal entry's hash should now be in the tracker.
    const rows = await ctx.replayPool.query<{
      hash: string;
      created_at: string;
    }>(`SELECT hash, created_at::text FROM drizzle.__drizzle_migrations`);
    const byHash = new Map<string, number>();
    for (const r of rows.rows) byHash.set(r.hash, Number(r.created_at));

    for (const entry of journal.entries) {
      const expectedHash = hashOf(entry.tag);
      expect(byHash.has(expectedHash), `missing tracker row for ${entry.tag}`).toBe(true);
      expect(byHash.get(expectedHash)).toBe(entry.when);
    }
  }, 60_000);

  it("is idempotent — second apply finds zero diff", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    // Tracker is already in sync from the previous test.
    const result = await reconcileTracker({
      pool: ctx.replayPool,
      migrationsFolder,
      apply: true,
      log: () => {},
    });

    expect(result.applied).toBe(false);
    expect(result.toInsert.length).toBe(0);
    expect(result.trackerCountAfter).toBe(journal.entries.length);
  }, 30_000);

  it("refuses to reconcile when a journal entry's SQL file is missing", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    // Build a self-contained migrations folder in a temp dir, then
    // delete one of the .sql files so the reconciler must throw before
    // it touches the DB.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-missing-"));
    const tmpMeta = path.join(tmpDir, "meta");
    fs.mkdirSync(tmpMeta, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "0000_a.sql"), "SELECT 1;");
    fs.writeFileSync(
      path.join(tmpMeta, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 0, version: "7", when: 1, tag: "0000_a", breakpoints: true },
          { idx: 1, version: "7", when: 2, tag: "0001_missing", breakpoints: true },
        ],
      }),
    );

    await expect(
      reconcileTracker({
        pool: ctx.replayPool,
        migrationsFolder: tmpDir,
        apply: false,
        log: () => {},
      }),
    ).rejects.toThrow(/missing SQL file/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  it("refuses to reconcile when two journal entries hash to the same content", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-dupe-"));
    const tmpMeta = path.join(tmpDir, "meta");
    fs.mkdirSync(tmpMeta, { recursive: true });
    // Two files with byte-identical content -> identical sha256 -> would
    // silently break the post-condition count invariant.
    fs.writeFileSync(path.join(tmpDir, "0000_a.sql"), "SELECT 1;");
    fs.writeFileSync(path.join(tmpDir, "0001_b.sql"), "SELECT 1;");
    fs.writeFileSync(
      path.join(tmpMeta, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 0, version: "7", when: 1, tag: "0000_a", breakpoints: true },
          { idx: 1, version: "7", when: 2, tag: "0001_b", breakpoints: true },
        ],
      }),
    );

    await expect(
      reconcileTracker({
        pool: ctx.replayPool,
        migrationsFolder: tmpDir,
        apply: false,
        log: () => {},
      }),
    ).rejects.toThrow(/duplicate migration content hashes/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  it("refuses to reconcile when tracker has hashes not in the journal", async (t) => {
    if (ctx.skipReason || !ctx.replayPool) {
      t.skip();
      return;
    }
    await seedTrackerWithFirstN(ctx.replayPool, 3);
    // Inject a junk hash that is NOT any journal entry's hash.
    await ctx.replayPool.query(
      `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)`,
      [
        crypto.createHash("sha256").update("ghost-migration").digest("hex"),
        Date.now(),
      ],
    );

    await expect(
      reconcileTracker({
        pool: ctx.replayPool,
        migrationsFolder,
        apply: true,
        log: () => {},
      }),
    ).rejects.toThrow(/not present in the journal/);

    // Nothing should have been inserted (we threw before BEGIN).
    const after = await ctx.replayPool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(after.rows[0]?.c ?? "0")).toBe(4);
  }, 30_000);
});
