/**
 * Database identity guard — Layer 2 (Task #137).
 *
 * Reads the single-row sentinel from `__database_identity` and
 * compares it to the URL fingerprint expectation from
 * `scripts/lib/database-identity.ts`. Throws on mismatch with a
 * runbook message naming the observed host, observed sentinel, and
 * expected sentinel.
 *
 * Auto-seeds the sentinel on first boot after migration 0023:
 *   - row missing  → INSERT with the URL-derived expected name
 *   - row matches  → OK
 *   - row wrong    → THROW
 *
 * Runs in `runMigrationsWith` AFTER the second
 * `assertSchemaMatchesTracker` so it's the last check before the
 * boot returns "ready". By that point the table is guaranteed to
 * exist (migration 0023 has run).
 *
 * In test contexts the throwaway-DB pattern provisions a fresh
 * database with no sentinel row; the auto-seed on first boot makes
 * those tests pass without needing an explicit setup step.
 */
import type pg from "pg";
import {
  buildIdentityFailureMessage,
  expectedIdentityFor,
  isFingerprintBootstrapped,
  parseDbUrl,
  PROD_IDENTITY_NAME,
} from "../../scripts/lib/database-identity";

export interface DatabaseIdentityOptions {
  pool: pg.Pool;
  /**
   * The connection string used to build `pool`. Defaults to
   * process.env.DATABASE_URL. Tests pass it explicitly so the
   * throwaway-DB URL is what gets fingerprinted, not the parent
   * env's DATABASE_URL.
   */
  databaseUrl?: string;
  /**
   * Override the source label used in error messages and logs.
   * Defaults to "boot".
   */
  source?: "boot" | "reconcile" | "repair";
}

/**
 * Whether we've already logged the "fingerprint not bootstrapped"
 * WARN this process. Logging it once per boot is enough; logging
 * it on every check call would spam the logs if the assertion is
 * called from multiple paths.
 */
let warnedAboutMissingFingerprint = false;

export async function assertDatabaseIdentity(
  opts: DatabaseIdentityOptions,
): Promise<void> {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const source = opts.source ?? "boot";
  const { host, dbname } = parseDbUrl(databaseUrl);
  const expected = expectedIdentityFor(databaseUrl);

  // Defensive existence probe. The migration that creates this table
  // is 0023; on a brand-new DB the boot path runs migrations BEFORE
  // calling this assertion, so the table is guaranteed present. If
  // somebody invokes this from an unusual entry point with the table
  // missing, fail loudly rather than silently no-op.
  const tablePresent = await opts.pool.query<{ reg: string | null }>(
    `SELECT to_regclass('public.__database_identity')::text AS reg`,
  );
  if (tablePresent.rows[0]?.reg == null) {
    throw new Error(
      `[${source}] FATAL — __database_identity table missing. Migration 0023_database_identity must run before this check.`,
    );
  }

  const existing = await opts.pool.query<{ value: string }>(
    `SELECT value FROM "__database_identity" WHERE id = 'name'`,
  );

  if (existing.rowCount === 0) {
    // First boot after the migration: auto-seed.
    await opts.pool.query(
      `INSERT INTO "__database_identity" (id, value) VALUES ('name', $1)
         ON CONFLICT (id) DO NOTHING`,
      [expected],
    );
    // eslint-disable-next-line no-console
    console.log(
      `[${source}] database identity bootstrapped: name=${expected} (host=${host || "<none>"}, dbname=${dbname || "<none>"})`,
    );

    // One-time WARN if Layer 1 isn't bootstrapped yet. This is the
    // "first deploy ever" scenario — the boot check is now active
    // (Layer 2 will catch the trap from here on) but the operator
    // still needs to commit the host fingerprint to activate Layer 1.
    if (!isFingerprintBootstrapped() && !warnedAboutMissingFingerprint) {
      warnedAboutMissingFingerprint = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[${source}] WARNING — host fingerprint EXPECTED_PROD_HOST is empty in scripts/lib/database-identity.ts. ` +
          `Layer 2 sentinel check is active, but Layer 1 host comparison is skipped until you complete the bootstrap runbook.`,
      );
    }
    return;
  }

  const observed = existing.rows[0]!.value;

  if (observed !== expected) {
    const msg = buildIdentityFailureMessage({
      source,
      observedHost: host,
      observedDbname: dbname,
      observedSentinel: observed,
      expectedSentinel: expected,
    });
    // eslint-disable-next-line no-console
    console.error(msg);
    throw new Error(msg);
  }

  // OK. Log once per boot at info level so the deploy log shows
  // identity verification succeeded — useful when grepping
  // post-incident for "did the guard run for revision X?".
  // eslint-disable-next-line no-console
  console.log(
    `[${source}] database identity verified: name=${observed} (host=${host || "<none>"})`,
  );

  // If the sentinel claims prod but Layer 1 says we're NOT looking
  // at prod (either because the host doesn't match or because the
  // fingerprint isn't bootstrapped), that's the trap. expectedFor
  // already returned the non-prod name in this case — so the
  // mismatch above would have thrown. Belt-and-braces sanity check:
  if (observed === PROD_IDENTITY_NAME && !isFingerprintBootstrapped()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[${source}] WARNING — DB self-identifies as ${PROD_IDENTITY_NAME} but EXPECTED_PROD_HOST is empty. ` +
        `Bootstrap scripts/lib/database-identity.ts immediately so Layer 1 starts catching wrong-host misconnections.`,
    );
  }
}
