#!/usr/bin/env node
/**
 * Bootstrap helper for Task #137.
 *
 * Reads PROD_DATABASE_URL and prints ONLY the hostname and dbname.
 * NEVER prints the username, password, or query string.
 *
 * Usage (operator runs once with PROD_DATABASE_URL in scope):
 *   node scripts/print-database-host.mjs
 *
 * Then paste the printed values into scripts/lib/database-identity.ts:
 *   EXPECTED_PROD_HOST   = "<hostname from output>"
 *   EXPECTED_PROD_DBNAME = "<dbname from output>"
 *
 * Commit. The next deploy activates Layer 1 of the database identity
 * guard.
 */
const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error("PROD_DATABASE_URL is not set in this environment.");
  console.error("Run this from a context where the secret is available.");
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch (err) {
  console.error("PROD_DATABASE_URL is not a valid URL:", err?.message ?? err);
  process.exit(1);
}

const host = parsed.hostname;
const dbname = parsed.pathname.replace(/^\/+/, "").split("?")[0] || "";

if (!host || !dbname) {
  console.error("Could not extract host/dbname from PROD_DATABASE_URL.");
  process.exit(1);
}

console.log("");
console.log("Paste these two values into scripts/lib/database-identity.ts:");
console.log("");
console.log(`  EXPECTED_PROD_HOST   = "${host}"`);
console.log(`  EXPECTED_PROD_DBNAME = "${dbname}"`);
console.log("");
console.log("Then commit and redeploy. (Credentials and query string");
console.log("are intentionally NOT printed.)");
