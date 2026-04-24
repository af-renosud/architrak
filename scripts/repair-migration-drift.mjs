#!/usr/bin/env node
// Repairs drift in drizzle.__drizzle_migrations.
//
// Two modes:
//   (default)         INSERT rows for journal entries whose SQL was applied by
//                     hand but never recorded in the tracker.
//   --prune-orphans   DELETE rows in the tracker whose created_at has no
//                     matching entry in migrations/meta/_journal.json.
//
// Both modes default to a dry-run preview; pass --apply to actually write.
//
// Usage:
//   node scripts/repair-migration-drift.mjs                          # preview missing-row inserts
//   node scripts/repair-migration-drift.mjs --apply                  # apply missing-row inserts
//   node scripts/repair-migration-drift.mjs --prune-orphans          # preview orphan deletes
//   node scripts/repair-migration-drift.mjs --prune-orphans --apply  # apply orphan deletes
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveMigrationsFolder() {
  const fromEnv = process.env.MIGRATIONS_FOLDER;
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "migrations"),
    path.resolve(here, "..", "migrations"),
    path.resolve(here, "..", "..", "migrations"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "meta", "_journal.json"))) return c;
  }
  return candidates[0];
}

export async function runPruneOrphans(drift, pool, apply) {
  const result = await drift.checkMigrationDrift();

  if (result.reason === "no-journal") {
    console.log("[repair] no journal found — nothing to do");
    return 0;
  }
  if (result.reason === "no-tracker") {
    console.log("[repair] tracker table not present yet — run the app once to let runMigrations() create it");
    return 0;
  }
  if (result.ok) {
    console.log(`[repair] in-sync — ${result.journalCount} journal entries match ${result.appliedCount} applied rows. Nothing to prune.`);
    return 0;
  }

  if (result.missingFromDb.length > 0) {
    console.warn(`[repair] WARNING — ${result.missingFromDb.length} journal entr(ies) missing from the tracker:`);
    for (const e of result.missingFromDb) {
      console.warn(`    - ${e.tag}  (when=${e.when})`);
    }
    console.warn("[repair] --prune-orphans only deletes orphan tracker rows; it does NOT insert missing rows.");
    console.warn("[repair] Re-run without --prune-orphans (with --apply) to insert the missing journal rows.");
  }

  if (result.orphanInDb.length === 0) {
    console.log("[repair] no orphan tracker rows to prune");
    return 0;
  }

  console.log(`[repair] ${apply ? "APPLY" : "DRY-RUN"} — ${result.orphanInDb.length} orphan row(s) to DELETE from drizzle.__drizzle_migrations:`);
  for (const o of result.orphanInDb) {
    console.log(`    - created_at=${o.created_at}`);
  }

  if (!apply) {
    console.log("");
    console.log("[repair] dry-run only. Re-run with --prune-orphans --apply to delete these rows.");
    return 0;
  }

  for (const o of result.orphanInDb) {
    const res = await pool.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [o.created_at],
    );
    console.log(`[repair] deleted ${res.rowCount} row(s) with created_at=${o.created_at}`);
  }

  const after = await drift.checkMigrationDrift();
  if (after.ok && after.reason === "in-sync") {
    console.log(`[repair] OK — drift check now reports in-sync (${after.journalCount} journal entries / ${after.appliedCount} applied rows)`);
    return 0;
  }
  console.warn(`[repair] WARNING — drift check still reports "${after.reason}" after prune:`);
  if (after.missingFromDb.length > 0) {
    console.warn(`  Still missing (${after.missingFromDb.length}):`);
    for (const e of after.missingFromDb) console.warn(`    - ${e.tag} (when=${e.when})`);
  }
  if (after.orphanInDb.length > 0) {
    console.warn(`  Orphans (${after.orphanInDb.length}):`);
    for (const o of after.orphanInDb) console.warn(`    - created_at=${o.created_at}`);
  }
  return 1;
}

export async function runInsertMissing(drift, pool, apply) {
  const result = await drift.checkMigrationDrift();

  if (result.reason === "no-journal") {
    console.log("[repair] no journal found — nothing to do");
    return 0;
  }
  if (result.reason === "no-tracker") {
    console.log("[repair] tracker table not present yet — run the app once to let runMigrations() create it");
    return 0;
  }
  if (result.ok) {
    console.log(`[repair] in-sync — ${result.journalCount} journal entries match ${result.appliedCount} applied rows. Nothing to repair.`);
    return 0;
  }

  if (result.orphanInDb.length > 0) {
    console.warn(`[repair] WARNING — ${result.orphanInDb.length} applied row(s) have no matching journal entry:`);
    for (const o of result.orphanInDb) {
      console.warn(`    - created_at=${o.created_at}`);
    }
    console.warn("[repair] This mode only inserts missing journal rows; it does NOT delete orphans.");
    console.warn("[repair] Re-run with --prune-orphans to remove them.");
  }

  if (result.missingFromDb.length === 0) {
    console.log("[repair] no missing journal entries to insert");
    return 0;
  }

  const migrationsFolder = resolveMigrationsFolder();

  const planned = [];
  for (const entry of result.missingFromDb) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) {
      console.error(`[repair] ERROR — SQL file missing for ${entry.tag}: ${sqlPath}`);
      return 2;
    }
    const sqlText = fs.readFileSync(sqlPath, "utf-8");
    const hash = crypto.createHash("sha256").update(sqlText).digest("hex");
    planned.push({ tag: entry.tag, when: entry.when, hash });
  }

  console.log(`[repair] ${apply ? "APPLY" : "DRY-RUN"} — ${planned.length} row(s) to insert into drizzle.__drizzle_migrations:`);
  for (const p of planned) {
    console.log(`    - ${p.tag}  when=${p.when}  hash=${p.hash}`);
  }

  if (!apply) {
    console.log("");
    console.log("[repair] dry-run only. Re-run with --apply to write these rows.");
    return 0;
  }

  for (const p of planned) {
    await pool.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [p.hash, p.when],
    );
    console.log(`[repair] inserted ${p.tag} (when=${p.when})`);
  }

  const after = await drift.checkMigrationDrift();
  if (after.ok && after.reason === "in-sync") {
    console.log(`[repair] OK — drift check now reports in-sync (${after.journalCount} journal entries / ${after.appliedCount} applied rows)`);
    return 0;
  }
  console.warn(`[repair] WARNING — drift check still reports "${after.reason}" after repair:`);
  if (after.missingFromDb.length > 0) {
    console.warn(`  Still missing (${after.missingFromDb.length}):`);
    for (const e of after.missingFromDb) console.warn(`    - ${e.tag} (when=${e.when})`);
  }
  if (after.orphanInDb.length > 0) {
    console.warn(`  Orphans (${after.orphanInDb.length}):`);
    for (const o of after.orphanInDb) console.warn(`    - created_at=${o.created_at}`);
  }
  return 1;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const pruneOrphans = process.argv.includes("--prune-orphans");
  const drift = await import("../server/migration-drift.ts");
  const { pool } = await import("../server/db.ts");

  // Database identity guard (Task #137). Required ONLY before
  // destructive writes — dry-run inspection is safe against any DB.
  // Refuses to --apply when the sentinel disagrees with the URL
  // fingerprint, closing the trap surfaced by ArchiDoc Task #294.
  if (apply) {
    const { assertDatabaseIdentity } = await import(
      "../server/operations/database-identity-check.ts"
    );
    await assertDatabaseIdentity({
      pool,
      databaseUrl: process.env.DATABASE_URL,
      source: "repair",
    });
  }

  if (pruneOrphans) {
    return await runPruneOrphans(drift, pool, apply);
  }
  return await runInsertMissing(drift, pool, apply);
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("repair-migration-drift.mjs");

if (isDirectRun) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error(e);
      process.exit(2);
    });
}
