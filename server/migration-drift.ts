import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db";

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export interface DriftResult {
  ok: boolean;
  reason?:
    | "no-tracker"
    | "no-journal"
    | "in-sync"
    | "tail-pending"
    | "drift"
    | "check-failed";
  journalCount: number;
  appliedCount: number;
  missingFromDb: JournalEntry[];
  orphanInDb: Array<{ created_at: number }>;
  error?: string;
}

function resolveMigrationsFolder(): string {
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

function readJournal(migrationsFolder: string): JournalEntry[] | null {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return entries
    .map((e: any) => ({ idx: Number(e.idx), tag: String(e.tag), when: Number(e.when) }))
    .sort((a: JournalEntry, b: JournalEntry) => a.idx - b.idx);
}

export async function checkMigrationDrift(): Promise<DriftResult> {
  const migrationsFolder = resolveMigrationsFolder();
  const journal = readJournal(migrationsFolder);

  const empty: DriftResult = {
    ok: true,
    journalCount: 0,
    appliedCount: 0,
    missingFromDb: [],
    orphanInDb: [],
  };

  if (!journal) {
    return { ...empty, reason: "no-journal" };
  }

  const tracker = await pool.query<{ reg: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS reg`,
  );
  const trackerExists = tracker.rows[0]?.reg != null;
  if (!trackerExists) {
    // Fresh database — runMigrations() will create the tracker. No drift to
    // report yet.
    return { ...empty, reason: "no-tracker", journalCount: journal.length };
  }

  const applied = await pool.query<{ created_at: string | null }>(
    `SELECT created_at::text AS created_at FROM drizzle.__drizzle_migrations`,
  );
  const appliedWhens = new Set<number>();
  for (const row of applied.rows) {
    if (row.created_at != null) appliedWhens.add(Number(row.created_at));
  }

  const journalWhens = new Set<number>(journal.map(e => e.when));
  const missingFromDb = journal.filter(e => !appliedWhens.has(e.when));
  const orphanInDb = [...appliedWhens]
    .filter(w => !journalWhens.has(w))
    .map(w => ({ created_at: w }));

  // "Tail-pending": the database is behind the journal by a contiguous tail
  // (e.g. journal idx 0..18, db has 0..14, missing = [15,16,17,18]). This is
  // the *normal* pre-deploy state when a release ships new migrations — the
  // app's runMigrations() call at startup will apply them. We must NOT treat
  // it as drift, otherwise the publish-time check deadlocks: every release
  // that introduces migrations would be blocked because prod is one step
  // behind by definition.
  //
  // True drift (which we still block on) is either:
  //   - orphan rows in the tracker (db has rows the journal doesn't know about)
  //   - interleaved gaps (db has 0015 but is missing 0014) — corruption
  const sortedJournal = [...journal].sort((a, b) => a.idx - b.idx);
  let tailPending = false;
  if (orphanInDb.length === 0 && missingFromDb.length > 0) {
    const firstMissingPos = sortedJournal.findIndex(
      e => !appliedWhens.has(e.when),
    );
    // Every entry from firstMissingPos onward must also be missing — i.e. the
    // applied set is a strict prefix of the journal. If anything after that
    // boundary IS applied, we have an interleaved gap, which is real drift.
    tailPending =
      firstMissingPos >= 0 &&
      sortedJournal
        .slice(firstMissingPos)
        .every(e => !appliedWhens.has(e.when));
  }

  const inSync = missingFromDb.length === 0 && orphanInDb.length === 0;
  const ok = inSync || tailPending;
  return {
    ok,
    reason: inSync ? "in-sync" : tailPending ? "tail-pending" : "drift",
    journalCount: journal.length,
    appliedCount: applied.rows.length,
    missingFromDb,
    orphanInDb,
  };
}

/**
 * Logs a loud, actionable warning when drift is detected. Returns the result
 * so callers (CLI / startup) can decide whether to exit non-zero.
 */
export async function reportMigrationDrift(): Promise<DriftResult> {
  let result: DriftResult;
  try {
    result = await checkMigrationDrift();
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[migrate:drift] check failed: ${msg}`);
    return {
      ok: false,
      reason: "check-failed",
      journalCount: 0,
      appliedCount: 0,
      missingFromDb: [],
      orphanInDb: [],
      error: msg,
    };
  }

  if (result.ok) {
    if (result.reason === "in-sync") {
      console.log(
        `[migrate:drift] OK — ${result.journalCount} journal entries match ${result.appliedCount} applied rows`,
      );
    } else if (result.reason === "tail-pending") {
      const pending = result.missingFromDb.map(e => e.tag).join(", ");
      console.log(
        `[migrate:drift] OK — ${result.appliedCount}/${result.journalCount} applied; ` +
          `${result.missingFromDb.length} pending migration(s) will be applied on startup: ${pending}`,
      );
    } else if (result.reason === "no-tracker") {
      console.log(
        `[migrate:drift] tracker table not present yet — fresh database, will be created by runMigrations()`,
      );
    }
    return result;
  }

  const bar = "=".repeat(72);
  console.warn(`\n${bar}`);
  if (result.reason === "check-failed") {
    console.warn("[migrate:drift] WARNING — drift check itself failed to run");
    console.warn(`  error: ${result.error ?? "unknown"}`);
    console.warn("  Treat as drift in CI / pre-deploy: an unusable check is not a passing check.");
    console.warn(`${bar}\n`);
    return result;
  }
  console.warn("[migrate:drift] WARNING — migration journal does not match the database");
  console.warn(
    `  journal entries: ${result.journalCount}   applied rows: ${result.appliedCount}`,
  );
  if (result.missingFromDb.length > 0) {
    console.warn(`  Missing from drizzle.__drizzle_migrations (${result.missingFromDb.length}):`);
    for (const e of result.missingFromDb) {
      console.warn(`    - ${e.tag}  (when=${e.when})`);
    }
  }
  if (result.orphanInDb.length > 0) {
    console.warn(`  Applied rows with no matching journal entry (${result.orphanInDb.length}):`);
    for (const o of result.orphanInDb) {
      console.warn(`    - created_at=${o.created_at}`);
    }
  }
  console.warn("");
  console.warn("  Why this matters: the deploy publish-time validator will refuse to ship");
  console.warn("  (or worse, threaten to drop production data) when the dev database has");
  console.warn("  drifted from the committed migrations.");
  console.warn("");
  console.warn("  How to fix:");
  console.warn("    1. Inspect drizzle.__drizzle_migrations and compare with migrations/meta/_journal.json");
  console.warn("    2. If the SQL was already applied by hand, INSERT the missing journal rows");
  console.warn("       (hash + created_at = `when` from the journal) so drizzle stops trying to re-run them");
  console.warn("    3. If the migration was never applied, run it manually and then add the row");
  console.warn(`${bar}\n`);
  return result;
}
