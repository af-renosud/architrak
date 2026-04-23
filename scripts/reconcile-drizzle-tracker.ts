/**
 * Reconcile the drizzle migration tracker (Task #135).
 *
 * Recovers from "tracker behind, schema fully forward" drift — the
 * inverse of the 2026-04-23 silent-partial-apply incident. When this
 * script is needed, every migration in `migrations/` has already been
 * applied to the database, but `drizzle.__drizzle_migrations` is
 * missing some rows, so on the next deploy drizzle's `migrate()` would
 * try to re-run those SQL files and crash on
 * `column/table/index ... already exists`.
 *
 * The script:
 *   1. Reads `migrations/meta/_journal.json` to get the canonical
 *      list of migrations and their `when` timestamps.
 *   2. For each entry, reads the raw `.sql` file and computes
 *      `sha256(rawSqlFileContent)` — the exact same algorithm drizzle
 *      uses (see node_modules/drizzle-orm/migrator.js readMigrationFiles).
 *   3. Connects to DATABASE_URL, queries existing tracker hashes.
 *   4. In ONE transaction:
 *        a. INSERT every (hash, created_at=journal.when) row that's
 *           missing from the tracker.
 *        b. Re-COUNT the tracker. If it doesn't match the journal entry
 *           count, ROLLBACK and exit non-zero (defensive — should never
 *           happen).
 *        c. COMMIT.
 *
 * Safety:
 *   - Dry-run by default. Pass `--apply` to actually write.
 *   - Idempotent: a second `--apply` run finds zero missing rows and
 *     exits 0 with "tracker already in sync".
 *   - Read-only on the migration .sql files. The script intentionally
 *     refuses to run if any journal entry has a missing/unreadable .sql
 *     file (drizzle would compute a different hash if the file content
 *     ever changed).
 *   - Never touches the schema. Only writes to drizzle.__drizzle_migrations.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/reconcile-drizzle-tracker.ts
 *   DATABASE_URL=postgres://... tsx scripts/reconcile-drizzle-tracker.ts --apply
 *
 * For programmatic use (tests):
 *   import { reconcileTracker } from "./reconcile-drizzle-tracker";
 *   const result = await reconcileTracker({ pool, migrationsFolder, apply: true });
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints?: boolean;
  version?: string;
}

interface JournalFile {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface PlannedInsert {
  tag: string;
  hash: string;
  createdAt: number;
}

export interface ReconcileResult {
  applied: boolean;
  journalCount: number;
  trackerCountBefore: number;
  trackerCountAfter: number;
  toInsert: PlannedInsert[];
  alreadyPresent: number;
  unexpectedExtraHashes: string[];
}

export interface ReconcileOptions {
  pool: pg.Pool;
  migrationsFolder: string;
  apply: boolean;
  log?: (msg: string) => void;
}

function readJournal(migrationsFolder: string): JournalFile {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    throw new Error(`[reconcile] journal not found: ${journalPath}`);
  }
  const raw = fs.readFileSync(journalPath, "utf-8");
  const parsed = JSON.parse(raw) as JournalFile;
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error(
      `[reconcile] journal has no entries: ${journalPath}`,
    );
  }
  return parsed;
}

function hashMigrationFile(migrationsFolder: string, tag: string): string {
  const sqlPath = path.join(migrationsFolder, `${tag}.sql`);
  if (!fs.existsSync(sqlPath)) {
    throw new Error(
      `[reconcile] missing SQL file for journal entry: ${sqlPath}`,
    );
  }
  // drizzle reads the file via fs.readFileSync(...).toString() (default
  // utf-8) and hashes the resulting string with sha256. We mirror that
  // exactly — any mismatch (BOM, line-ending changes, etc.) would make
  // our reconciled rows invisible to drizzle on the next deploy.
  const content = fs.readFileSync(sqlPath).toString();
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function reconcileTracker(
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const log = opts.log ?? ((msg: string) => console.log(msg));

  const journal = readJournal(opts.migrationsFolder);
  const planned: PlannedInsert[] = journal.entries
    .slice()
    // Insert in journal-when order so the tracker rows land in the
    // same order drizzle would have written them. Tracker has no
    // explicit ordering column besides created_at; drizzle uses
    // created_at to compare against folderMillis when deciding what's
    // pending.
    .sort((a, b) => a.when - b.when)
    .map((entry) => ({
      tag: entry.tag,
      hash: hashMigrationFile(opts.migrationsFolder, entry.tag),
      createdAt: entry.when,
    }));

  // Sanity: hashes must be unique. If two migration files happen to
  // have identical contents, the tracker would only need one row for
  // them, which would silently break the count invariant. Fail loud.
  const hashCounts = new Map<string, string[]>();
  for (const p of planned) {
    const arr = hashCounts.get(p.hash) ?? [];
    arr.push(p.tag);
    hashCounts.set(p.hash, arr);
  }
  const dupes = [...hashCounts.entries()].filter(([, tags]) => tags.length > 1);
  if (dupes.length > 0) {
    const summary = dupes
      .map(([h, tags]) => `${h.slice(0, 12)}…: ${tags.join(", ")}`)
      .join("; ");
    throw new Error(
      `[reconcile] duplicate migration content hashes detected (would break tracker count invariant): ${summary}`,
    );
  }

  const client = await opts.pool.connect();
  try {
    // Probe (read-only) for the tracker table. We deliberately do NOT
    // CREATE SCHEMA / CREATE TABLE in dry-run mode — dry-run must be
    // strictly non-mutating. If the tracker is missing entirely (e.g.
    // partial restore that excluded the drizzle schema), we treat the
    // existing-hashes set as empty and let `--apply` do the bootstrap.
    const probe = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
       ) AS exists`,
    );
    const trackerTableExists = probe.rows[0]?.exists === true;

    let existingHashes: Set<string>;
    let trackerCountBefore: number;
    if (trackerTableExists) {
      const existing = await client.query<{ hash: string }>(
        `SELECT hash FROM drizzle.__drizzle_migrations`,
      );
      existingHashes = new Set(existing.rows.map((r) => r.hash));
      trackerCountBefore = existing.rows.length;
    } else {
      existingHashes = new Set();
      trackerCountBefore = 0;
      log(
        `[reconcile] tracker table drizzle.__drizzle_migrations does not exist; will bootstrap on --apply.`,
      );
    }

    const toInsert = planned.filter((p) => !existingHashes.has(p.hash));
    const plannedHashes = new Set(planned.map((p) => p.hash));
    const unexpectedExtraHashes = [...existingHashes].filter(
      (h) => !plannedHashes.has(h),
    );

    log(
      `[reconcile] journal entries: ${planned.length} | tracker rows: ${trackerCountBefore} | missing: ${toInsert.length} | unexpected extras: ${unexpectedExtraHashes.length}`,
    );

    if (unexpectedExtraHashes.length > 0) {
      // Tracker has rows whose hash isn't in the journal at all. That
      // means *something* once applied a migration whose file is no
      // longer on disk (or whose contents were edited). We refuse to
      // proceed because COMMITting would still leave the tracker in
      // an inconsistent state vs. the journal, and the post-condition
      // (count == journal length) would fail or pass for the wrong
      // reason. Operator must investigate.
      throw new Error(
        `[reconcile] tracker contains ${unexpectedExtraHashes.length} hash(es) not present in the journal — refusing to reconcile. Investigate before re-running. Sample extras: ${unexpectedExtraHashes.slice(0, 3).join(", ")}`,
      );
    }

    for (const p of toInsert) {
      log(
        `[reconcile]   + ${p.tag}  hash=${p.hash.slice(0, 12)}…  created_at=${p.createdAt}`,
      );
    }

    if (toInsert.length === 0) {
      log(`[reconcile] tracker already in sync — nothing to do.`);
      return {
        applied: false,
        journalCount: planned.length,
        trackerCountBefore,
        trackerCountAfter: trackerCountBefore,
        toInsert: [],
        alreadyPresent: trackerCountBefore,
        unexpectedExtraHashes,
      };
    }

    if (!opts.apply) {
      log(
        `[reconcile] DRY RUN — pass --apply to insert the ${toInsert.length} row(s) above.`,
      );
      return {
        applied: false,
        journalCount: planned.length,
        trackerCountBefore,
        trackerCountAfter: trackerCountBefore,
        toInsert,
        alreadyPresent: trackerCountBefore,
        unexpectedExtraHashes,
      };
    }

    await client.query("BEGIN");
    let trackerCountAfter = trackerCountBefore;
    try {
      for (const p of toInsert) {
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)`,
          [p.hash, p.createdAt],
        );
      }
      const after = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM drizzle.__drizzle_migrations`,
      );
      trackerCountAfter = Number(after.rows[0]?.c ?? "0");

      if (trackerCountAfter !== planned.length) {
        throw new Error(
          `[reconcile] post-condition failed: tracker has ${trackerCountAfter} rows after insert, expected ${planned.length} (journal). Rolling back.`,
        );
      }

      await client.query("COMMIT");
      log(
        `[reconcile] APPLIED — inserted ${toInsert.length} row(s). Tracker now has ${trackerCountAfter} rows (journal: ${planned.length}).`,
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }

    return {
      applied: true,
      journalCount: planned.length,
      trackerCountBefore,
      trackerCountAfter,
      toInsert,
      alreadyPresent: trackerCountBefore,
      unexpectedExtraHashes,
    };
  } finally {
    client.release();
  }
}

const isMain = (() => {
  try {
    return (
      process.argv[1] &&
      path.resolve(process.argv[1]) ===
        path.resolve(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "[reconcile] DATABASE_URL is not set. Refusing to run.",
    );
    process.exit(1);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.resolve(here, "..", "migrations");

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });

  reconcileTracker({ pool, migrationsFolder, apply })
    .then(async (result) => {
      await pool.end();
      if (!apply && result.toInsert.length > 0) {
        // Distinguishable exit code so CI/operators can detect "diff
        // exists but nothing was written".
        process.exit(2);
      }
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      try {
        await pool.end();
      } catch {
        // ignore
      }
      process.exit(1);
    });
}
