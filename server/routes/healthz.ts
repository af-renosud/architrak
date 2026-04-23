import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db } from "../db";
import { rateLimit } from "../middleware/rate-limit";
import * as schema from "@shared/schema";

// Deep health check (Task #125).
//
// Background: when migrations 0019/0020 silently skipped on prod (the
// 2026-04-23 incident) the deploy infrastructure had no way of knowing
// the new revision was broken — port-listen was the only readiness
// signal. This endpoint exercises every Drizzle-modeled table with a
// schema-projecting `SELECT ... WHERE FALSE` so any column declared in
// `shared/schema.ts` but missing from the live DB raises a Postgres
// error inside the query rather than waiting for a real user request.
//
// The endpoint is intentionally PUBLIC (no auth) so deploy automation
// and external uptime monitors can hit it without provisioning
// session cookies. To keep it from becoming a DB-amplification ddos
// vector it is hard rate-limited per-caller. The cheap `/healthz`
// liveness endpoint stays open for the platform's port-listen probe.

interface DeepFailure {
  table: string;
  error: string;
}

/**
 * Discover every PgTable instance exported from `@shared/schema`.
 * Mirrors the pattern used by the migration-replay test (Task #124)
 * so the two safety nets agree on the table set they cover.
 */
export function discoverSchemaTables(): { name: string; table: PgTable }[] {
  const out: { name: string; table: PgTable }[] = [];
  for (const value of Object.values(schema)) {
    if (value == null || typeof value !== "object") continue;
    try {
      const cfg = getTableConfig(value as PgTable);
      out.push({ name: cfg.name, table: value as PgTable });
    } catch {
      // Not a PgTable export (zod schema, type alias, helper, ...).
    }
  }
  // Stable ordering for deterministic logs.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface DeepHealthResult {
  status: "ok" | "degraded";
  checked: number;
  failures: DeepFailure[];
  durationMs: number;
}

/**
 * Run the deep health probe against the supplied Drizzle handle.
 * Exported separately from the route so the post-deploy smoke
 * script and unit tests can exercise the same code path without
 * spinning up an Express app.
 */
export async function runDeepHealthCheck(
  database: typeof db = db,
): Promise<DeepHealthResult> {
  const started = Date.now();
  const tables = discoverSchemaTables();
  const failures: DeepFailure[] = [];

  for (const { name, table } of tables) {
    try {
      // `db.select().from(table)` projects every column declared on the
      // Drizzle table — exactly the surface area the application code
      // relies on. `WHERE FALSE` ensures Postgres still parses, plans
      // and validates the projection list against the live catalog
      // without returning rows or scanning data. A missing column
      // raises `column "x" does not exist` here, which is precisely
      // the failure mode 0019/0020 produced after silently skipping.
      await database.select().from(table).where(sql`false`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ table: name, error: message });
    }
  }

  return {
    status: failures.length === 0 ? "ok" : "degraded",
    checked: tables.length,
    failures,
    durationMs: Date.now() - started,
  };
}

// Per-caller rate limit: 30 requests / minute is more than enough for
// platform probes + uptime monitors + the post-deploy smoke script,
// while preventing a hostile caller from issuing dozens of multi-table
// scans per second against the production DB.
const deepHealthLimiter = rateLimit({
  name: "healthz-deep",
  windowMs: 60_000,
  max: 30,
  message: "Deep health check rate limit exceeded",
});

const router = Router();

// Cheap liveness probe — no DB hit, only confirms the process is up.
router.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// Deep readiness probe — exercises every modeled table.
router.get(
  "/healthz/deep",
  deepHealthLimiter,
  async (_req: Request, res: Response) => {
    const result = await runDeepHealthCheck();
    if (result.status === "degraded") {
      // Surface failures in the deploy log via the existing error
      // channel so on-call sees them next to other application errors
      // rather than buried in a 503 body alone.
      console.error(
        `[healthz-deep] degraded: ${result.failures.length}/${result.checked} table(s) failed`,
        result.failures,
      );
      res.status(503).json(result);
      return;
    }
    res.status(200).json(result);
  },
);

export default router;
