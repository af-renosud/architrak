/**
 * Database identity guard (Task #137).
 *
 * Layer 1 of two — see server/operations/database-identity-check.ts
 * for Layer 2 (the in-DB sentinel row).
 *
 * Inspired by ArchiDoc Task #294: PROD_DATABASE_URL was silently
 * pointing at an orphan Neon database for an unknown amount of time,
 * and nothing in the codebase or platform could detect that the
 * secret was wrong. Every shape-based safety check (count invariant,
 * schema-presence, deep healthz) happily ran against any DB with a
 * matching schema, including the wrong one.
 *
 * This module pins the expected production hostname IN CODE so the
 * destructive scripts and the boot path can refuse to proceed when
 * the URL host disagrees. The companion sentinel row (Layer 2)
 * defends against the case where Neon migrates the endpoint behind
 * the same DNS name.
 *
 * BOOTSTRAP RUNBOOK (operator action):
 *   1. Run `node scripts/print-database-host.mjs` with PROD_DATABASE_URL
 *      in scope. It prints ONLY the hostname and dbname — never the
 *      password or query string.
 *   2. Paste the printed hostname into EXPECTED_PROD_HOST below and
 *      the dbname into EXPECTED_PROD_DBNAME.
 *   3. Commit. The next deploy activates Layer 1 of the guard.
 *
 * Until step 2 is done, EXPECTED_PROD_HOST stays empty. The boot
 * check logs a single WARN line in production and skips the host
 * comparison; Layer 2 (the in-DB sentinel row) remains fully active
 * regardless. This avoids a chicken-and-egg deploy break the very
 * first time the guard ships.
 */

/**
 * Production Neon hostname for ArchiTrak. Empty string means
 * "not yet bootstrapped — see runbook above".
 *
 * NEVER paste credentials here. Hostname only.
 */
export const EXPECTED_PROD_HOST: string = "ep-autumn-union-ajp6k1vo.c-3.us-east-2.aws.neon.tech";

/**
 * Production database name (the path component of the URL after
 * the host, before any query string). Empty string means
 * "not yet bootstrapped".
 */
export const EXPECTED_PROD_DBNAME: string = "neondb";

/**
 * The expected sentinel value for `__database_identity.value` when
 * the URL fingerprint matches production.
 */
export const PROD_IDENTITY_NAME = "architrak-prod";

/**
 * The expected sentinel value when the URL fingerprint does NOT
 * match production. Dev / preview / CI all share this name; the
 * point of the sentinel is to catch a wrong-prod misconnection,
 * not to differentiate between non-prod environments.
 */
export const NONPROD_IDENTITY_NAME = "architrak-dev";

export interface ParsedDbUrl {
  host: string;
  dbname: string;
}

/**
 * Extract the hostname and dbname from a postgres URL. Defensive:
 * never throws — returns empty strings on invalid input so the
 * caller's error message can name the cause precisely.
 */
export function parseDbUrl(url: string | undefined | null): ParsedDbUrl {
  if (!url) return { host: "", dbname: "" };
  try {
    const u = new URL(url);
    const dbname = u.pathname.replace(/^\/+/, "").split("?")[0] ?? "";
    return { host: u.hostname, dbname };
  } catch {
    return { host: "", dbname: "" };
  }
}

/**
 * True iff the given URL looks like the production database
 * according to the in-code fingerprint. Returns false when the
 * fingerprint is not bootstrapped (EXPECTED_PROD_HOST === "").
 */
export function urlMatchesProdFingerprint(url: string | undefined | null): boolean {
  if (!EXPECTED_PROD_HOST) return false;
  const { host, dbname } = parseDbUrl(url);
  if (!host) return false;
  if (host !== EXPECTED_PROD_HOST) return false;
  // Dbname check is only enforced when the operator has bootstrapped
  // it. Allowing an empty EXPECTED_PROD_DBNAME would be a footgun
  // (a host match alone could pass against a sibling DB on the same
  // Neon project), so refuse.
  if (!EXPECTED_PROD_DBNAME) return false;
  return dbname === EXPECTED_PROD_DBNAME;
}

/**
 * Returns the expected sentinel-row value for the given URL.
 * "architrak-prod" if the URL matches the prod fingerprint,
 * "architrak-dev" otherwise. Used by the boot check to decide
 * what to seed and what to verify.
 */
export function expectedIdentityFor(url: string | undefined | null): string {
  return urlMatchesProdFingerprint(url) ? PROD_IDENTITY_NAME : NONPROD_IDENTITY_NAME;
}

/**
 * True iff the operator has completed the bootstrap step.
 * Used by callers that want to log a one-time WARN when the
 * fingerprint is missing.
 */
export function isFingerprintBootstrapped(): boolean {
  return EXPECTED_PROD_HOST !== "" && EXPECTED_PROD_DBNAME !== "";
}

/**
 * Build the operator runbook message for a wrong-DB detection.
 * Centralised so the boot check and the destructive scripts emit
 * the same text — easier to grep for in incident logs.
 */
export function buildIdentityFailureMessage(opts: {
  source: "boot" | "reconcile" | "repair";
  observedHost: string;
  observedDbname: string;
  observedSentinel: string | null;
  expectedSentinel: string;
}): string {
  const { source, observedHost, observedDbname, observedSentinel, expectedSentinel } = opts;
  const fingerprintLine = isFingerprintBootstrapped()
    ? `  expected prod host: ${EXPECTED_PROD_HOST}\n  expected prod dbname: ${EXPECTED_PROD_DBNAME}`
    : `  (host fingerprint NOT bootstrapped — see scripts/lib/database-identity.ts runbook)`;
  return [
    `[${source}] FATAL — database identity mismatch (Task #137).`,
    `  observed host: ${observedHost || "<unparseable>"}`,
    `  observed dbname: ${observedDbname || "<unparseable>"}`,
    `  observed sentinel value: ${observedSentinel ?? "<row missing>"}`,
    `  expected sentinel value: ${expectedSentinel}`,
    fingerprintLine,
    `Refusing to proceed. Verify the DATABASE_URL secret in the deployment env`,
    `against the Neon console: project, branch, and database name must all`,
    `match what scripts/lib/database-identity.ts declares as production.`,
  ].join("\n");
}
