import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "path";
import type pg from "pg";
import { fileURLToPath } from "url";
import { db as defaultDb, pool as defaultPool } from "./db";

export function resolveMigrationsFolder(): string {
  const fromEnv = process.env.MIGRATIONS_FOLDER;
  if (fromEnv) return fromEnv;

  const candidates: string[] = [];
  candidates.push(path.resolve(process.cwd(), "migrations"));

  try {
    const here = typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, "..", "migrations"));
    candidates.push(path.resolve(here, "..", "..", "migrations"));
  } catch {
  }

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "meta", "_journal.json"))) return c;
  }
  return candidates[0];
}

/**
 * Bootstrap the migration tracking table for databases that already contain the
 * schema (created by an earlier `drizzle-kit push`). If the application's
 * tables exist but the `drizzle.__drizzle_migrations` table does not, we mark
 * the baseline migration as already applied so the migrator does not try to
 * re-create existing tables. Safe because the baseline was generated FROM the
 * live schema.
 */
async function bootstrapBaselineIfNeeded(
  migrationsFolder: string,
  pool: pg.Pool,
  db: NodePgDatabase<Record<string, never>> | NodePgDatabase<Record<string, unknown>>,
): Promise<void> {
  const tracker = await pool.query<{ reg: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS reg`,
  );
  const trackerExists = tracker.rows[0]?.reg != null;
  if (trackerExists) {
    const count = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM drizzle.__drizzle_migrations`,
    );
    if (Number(count.rows[0]?.c ?? "0") > 0) return;
  }

  const sentinelTables = [
    "public.users",
    "public.projects",
    "public.invoices",
    "public.devis",
  ];
  const probe = await pool.query<{ found: number }>(
    `SELECT COUNT(*)::int AS found
     FROM unnest($1::text[]) AS t(name)
     WHERE to_regclass(t.name) IS NOT NULL`,
    [sentinelTables],
  );
  const schemaExists = (probe.rows[0]?.found ?? 0) >= sentinelTables.length;
  if (!schemaExists) return;

  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
  const entries: Array<{ tag: string; when: number }> = journal.entries ?? [];
  if (entries.length === 0) return;
  const baseline = entries[0];

  const sqlPath = path.join(migrationsFolder, `${baseline.tag}.sql`);
  const sqlText = fs.readFileSync(sqlPath, "utf-8");
  const hash = crypto.createHash("sha256").update(sqlText).digest("hex");

  console.log(`[migrate] bootstrapping __drizzle_migrations with baseline ${baseline.tag}`);
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  await pool.query(
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
    [hash, baseline.when],
  );
}

/**
 * Compare the journal entry count to the row count in
 * `drizzle.__drizzle_migrations`. If they differ, drizzle's migrate()
 * silently partial-applied (the 2026-04-23 P0 incident: "[migrate] done"
 * was logged while only 4 of 6 pending migrations actually ran, leaving
 * pdf_page_hint / pdf_bbox missing in prod and the API 500-ing). Throw
 * so the deployer refuses to start — better a failed deploy than silent
 * prod drift.
 *
 * Exported so the migration-replay test (Task #124) and any other
 * caller can reuse the exact same invariant.
 */
export async function assertJournalMatchesTracker(opts: {
  pool: pg.Pool;
  migrationsFolder?: string;
}): Promise<void> {
  const migrationsFolder = opts.migrationsFolder ?? resolveMigrationsFolder();
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as {
    entries?: Array<{ tag: string; when: number }>;
  };
  const journalCount = journal.entries?.length ?? 0;

  const result = await opts.pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM drizzle.__drizzle_migrations`,
  );
  const trackerCount = Number(result.rows[0]?.c ?? "0");

  if (journalCount !== trackerCount) {
    const msg = `[migrate] FATAL — journal has ${journalCount} entries, tracker has ${trackerCount}; partial apply detected`;
    console.error(msg);
    throw new Error(msg);
  }
}

/**
 * Run migrations against a specific database. Extracted from
 * {@link runMigrations} so callers (e.g. the migration-replay test)
 * can target a throwaway database without overriding `DATABASE_URL`
 * at process scope.
 *
 * The default `runMigrations()` delegates here against the
 * application's main pool/db.
 */
export async function runMigrationsWith(opts: {
  pool: pg.Pool;
  db?: NodePgDatabase<Record<string, never>> | NodePgDatabase<Record<string, unknown>>;
  migrationsFolder?: string;
}): Promise<void> {
  const migrationsFolder = opts.migrationsFolder ?? resolveMigrationsFolder();
  const dbHandle = opts.db ?? drizzle(opts.pool);
  const start = Date.now();
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await bootstrapBaselineIfNeeded(migrationsFolder, opts.pool, dbHandle);
  await migrate(dbHandle, { migrationsFolder });
  await assertJournalMatchesTracker({ pool: opts.pool, migrationsFolder });
  console.log(`[migrate] done in ${Date.now() - start}ms`);
}

export async function runMigrations(): Promise<void> {
  await runMigrationsWith({ pool: defaultPool, db: defaultDb });
}
