/**
 * Tests for server/operations/database-identity-check.ts (Task #137).
 *
 * Provisions a throwaway Postgres database (same pattern as
 * schema-presence-check.test.ts), replays every migration via
 * runMigrationsWith — which now ends with assertDatabaseIdentity —
 * and exercises the four states the guard must handle:
 *
 *   1. fresh DB, no sentinel row     → auto-seed with non-prod name
 *   2. row matches expectation       → no throw
 *   3. row says "architrak-prod" but
 *      the URL doesn't match the
 *      prod fingerprint              → throw with runbook
 *   4. table missing entirely        → throw with explicit cause
 *
 * Plus a unit-level test for the URL parser and expectedIdentityFor
 * helpers in scripts/lib/database-identity.ts — these don't need a
 * real DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrationsWith } from "../migrate";
import { assertDatabaseIdentity } from "../operations/database-identity-check";
import {
  parseDbUrl,
  expectedIdentityFor,
  buildIdentityFailureMessage,
  isFingerprintBootstrapped,
  NONPROD_IDENTITY_NAME,
  PROD_IDENTITY_NAME,
} from "../../scripts/lib/database-identity";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "..", "..", "migrations");

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

interface Ctx {
  adminPool?: pg.Pool;
  replayPool?: pg.Pool;
  replayDbName?: string;
  replayUrl?: string;
  skipReason: string | null;
}
const ctx: Ctx = { skipReason: null };

describe("database-identity helpers (Task #137 — pure)", () => {
  it("parseDbUrl extracts host and dbname; returns empty strings on garbage", () => {
    expect(
      parseDbUrl("postgres://user:pw@ep-foo.us-east-2.aws.neon.tech/main_db?sslmode=require"),
    ).toEqual({ host: "ep-foo.us-east-2.aws.neon.tech", dbname: "main_db" });
    expect(parseDbUrl("not a url")).toEqual({ host: "", dbname: "" });
    expect(parseDbUrl(undefined)).toEqual({ host: "", dbname: "" });
    expect(parseDbUrl(null)).toEqual({ host: "", dbname: "" });
  });

  it("expectedIdentityFor returns NONPROD_IDENTITY_NAME when fingerprint is not bootstrapped", () => {
    // The committed default state: EXPECTED_PROD_HOST is empty.
    // Until the operator runs scripts/print-database-host.mjs and
    // pastes the host, every URL maps to non-prod.
    expect(isFingerprintBootstrapped()).toBe(false);
    expect(expectedIdentityFor("postgres://x:y@anything/anything")).toBe(
      NONPROD_IDENTITY_NAME,
    );
  });

  it("buildIdentityFailureMessage names host, dbname, observed/expected sentinel, and source", () => {
    const msg = buildIdentityFailureMessage({
      source: "boot",
      observedHost: "ep-wrong.us.aws.neon.tech",
      observedDbname: "wrong_db",
      observedSentinel: PROD_IDENTITY_NAME,
      expectedSentinel: NONPROD_IDENTITY_NAME,
    });
    expect(msg).toMatch(/FATAL/);
    expect(msg).toMatch(/Task #137/);
    expect(msg).toMatch(/ep-wrong\.us\.aws\.neon\.tech/);
    expect(msg).toMatch(/wrong_db/);
    expect(msg).toMatch(/architrak-prod/);
    expect(msg).toMatch(/architrak-dev/);
    expect(msg).toMatch(/Refusing to proceed/);
  });
});

const skipModule = !DATABASE_URL ? "DATABASE_URL is not set" : null;

describe.skipIf(skipModule !== null)(
  "database-identity check — integration (Task #137)",
  () => {
    beforeAll(async () => {
      if (!DATABASE_URL) return;
      ctx.adminPool = new Pool({
        connectionString: buildAdminUrl(DATABASE_URL),
        max: 2,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 10000,
      });

      ctx.replayDbName = `db_identity_test_${Date.now()}_${Math.floor(
        Math.random() * 1e6,
      )}`;
      try {
        await ctx.adminPool.query(`CREATE DATABASE "${ctx.replayDbName}"`);
      } catch (err) {
        ctx.skipReason = `cannot CREATE DATABASE on this server: ${errMessage(err)}`;
        // eslint-disable-next-line no-console
        console.warn(`[db-identity-test] SKIPPED — ${ctx.skipReason}`);
        return;
      }

      ctx.replayUrl = buildReplayUrl(DATABASE_URL, ctx.replayDbName);
      ctx.replayPool = new Pool({
        connectionString: ctx.replayUrl,
        max: 4,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 10000,
      });

      // runMigrationsWith now ends with assertDatabaseIdentity, which
      // auto-seeds the row on first boot. If the seed itself fails
      // the suite fails loudly — exactly what we want.
      await runMigrationsWith({
        pool: ctx.replayPool,
        migrationsFolder,
      });
    }, 120_000);

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
          console.warn(
            `[db-identity-test] cleanup warning: ${errMessage(err)}`,
          );
        } finally {
          await ctx.adminPool.end();
        }
      }
    }, 30_000);

    it("auto-seeded the sentinel row to architrak-dev on first boot", async (t) => {
      if (ctx.skipReason || !ctx.replayPool) {
        t.skip();
        return;
      }
      const r = await ctx.replayPool.query<{ value: string }>(
        `SELECT value FROM "__database_identity" WHERE id = 'name'`,
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]!.value).toBe(NONPROD_IDENTITY_NAME);
    });

    it("a second invocation with the matching sentinel does not throw", async (t) => {
      if (ctx.skipReason || !ctx.replayPool) {
        t.skip();
        return;
      }
      await expect(
        assertDatabaseIdentity({
          pool: ctx.replayPool,
          databaseUrl: ctx.replayUrl,
          source: "boot",
        }),
      ).resolves.toBeUndefined();
    });

    it("throws when the sentinel claims architrak-prod but the URL doesn't match the prod fingerprint", async (t) => {
      if (ctx.skipReason || !ctx.replayPool) {
        t.skip();
        return;
      }
      // Mutate the row to claim prod identity. The URL host
      // (the throwaway test DB) does NOT match EXPECTED_PROD_HOST
      // — even after the operator bootstraps it, since this is a
      // local replay DB. So the guard MUST throw.
      await ctx.replayPool.query(
        `UPDATE "__database_identity" SET value = $1 WHERE id = 'name'`,
        [PROD_IDENTITY_NAME],
      );

      try {
        await expect(
          assertDatabaseIdentity({
            pool: ctx.replayPool,
            databaseUrl: ctx.replayUrl,
            source: "boot",
          }),
        ).rejects.toThrow(/Task #137/);
      } finally {
        // Restore so subsequent tests see the expected baseline.
        await ctx.replayPool.query(
          `UPDATE "__database_identity" SET value = $1 WHERE id = 'name'`,
          [NONPROD_IDENTITY_NAME],
        );
      }
    });

    it("throws with an explicit cause when the table is missing entirely", async (t) => {
      if (ctx.skipReason || !ctx.replayPool) {
        t.skip();
        return;
      }
      // Drop and re-create around the assertion. This synthesises
      // the "somebody invoked the check from a context where 0023
      // hasn't run" failure mode — in the real boot path migrate()
      // creates the table first, but a CLI script that bypasses
      // migrate() would hit this branch.
      await ctx.replayPool.query(
        `ALTER TABLE "__database_identity" RENAME TO "__database_identity_hidden"`,
      );
      try {
        await expect(
          assertDatabaseIdentity({
            pool: ctx.replayPool,
            databaseUrl: ctx.replayUrl,
            source: "boot",
          }),
        ).rejects.toThrow(/__database_identity table missing/);
      } finally {
        await ctx.replayPool.query(
          `ALTER TABLE "__database_identity_hidden" RENAME TO "__database_identity"`,
        );
      }
    });

    it("schema-presence check covers 0023 (no uncovered-tag throw)", async (t) => {
      if (ctx.skipReason || !ctx.replayPool) {
        t.skip();
        return;
      }
      const { assertSchemaMatchesTracker } = await import(
        "../operations/schema-presence-check"
      );
      await expect(
        assertSchemaMatchesTracker({
          pool: ctx.replayPool,
          migrationsFolder,
        }),
      ).resolves.toBeUndefined();
    });
  },
);
