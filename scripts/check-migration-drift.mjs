#!/usr/bin/env node
// Compares migrations/meta/_journal.json against drizzle.__drizzle_migrations
// in the live database. Exits non-zero on drift so CI / pre-deploy can block.
//
// Usage:
//   node scripts/check-migration-drift.mjs            # warn + exit 1 on drift
//   node scripts/check-migration-drift.mjs --warn-only # always exit 0
import("../server/migration-drift.ts")
  .then(async (m) => {
    const result = await m.reportMigrationDrift();
    const warnOnly = process.argv.includes("--warn-only");
    if (!result.ok && !warnOnly) {
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
