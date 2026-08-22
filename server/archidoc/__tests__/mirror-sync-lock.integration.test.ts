import { describe, it, expect, afterAll } from "vitest";
import { db, pool } from "../../db";
import { archidocSyncLog, archidocTechnicalLots } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  fullSync,
  incrementalSync,
  recoverStaleRunningSyncLogs,
  clearPreviousBackendMirrorRows,
  withMirrorSyncLock,
} from "../sync-service";
import { runContractorAutoSync } from "../contractor-auto-sync";

// All production mirror-sync triggers (HTTP sync route -> fullSync, webhook
// sync.full -> fullSync, scheduler -> incrementalSync / runContractorAutoSync)
// must serialize on the shared advisory lock: when it is held, they must
// report "already running" instead of reconciling concurrently — and
// stale-run recovery must refuse to touch live runs.
describe("mirror sync lock contract", () => {
  async function holdLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('archidoc_mirror_sync'))");
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext('archidoc_mirror_sync'))");
      }
    } finally {
      client.release();
    }
  }

  it("fullSync reports alreadyRunning when the lock is held", async () => {
    const result = await holdLock(() => fullSync());
    expect(result.alreadyRunning).toBe(true);
    expect(result.projects.updated).toBe(0);
  });

  it("incrementalSync reports alreadyRunning when the lock is held", async () => {
    const result = await holdLock(() => incrementalSync());
    expect(result.alreadyRunning).toBe(true);
  });

  it("runContractorAutoSync reports alreadyRunning when the lock is held", async () => {
    const result = await holdLock(() => runContractorAutoSync({ incremental: false }));
    expect(result.alreadyRunning).toBe(true);
    expect(result.mirrorUpdated).toBe(0);
  });

  it("stale-run recovery skips while a sync is live, recovers after release", async () => {
    const [stale] = await db
      .insert(archidocSyncLog)
      .values({
        syncType: "projects",
        status: "running",
        startedAt: new Date(Date.now() - 20 * 60 * 1000),
      })
      .returning();
    try {
      const whileHeld = await holdLock(() => recoverStaleRunningSyncLogs());
      expect(whileHeld).toBe(0);
      const [rowStillRunning] = await db
        .select()
        .from(archidocSyncLog)
        .where(eq(archidocSyncLog.id, stale.id));
      expect(rowStillRunning.status).toBe("running");

      const afterRelease = await recoverStaleRunningSyncLogs();
      expect(afterRelease).toBeGreaterThanOrEqual(1);
      const [rowRecovered] = await db
        .select()
        .from(archidocSyncLog)
        .where(eq(archidocSyncLog.id, stale.id));
      expect(rowRecovered.status).toBe("failed");
    } finally {
      await db.delete(archidocSyncLog).where(eq(archidocSyncLog.id, stale.id));
    }
  });

  it("withMirrorSyncLock is exclusive against itself", async () => {
    const outcome = await withMirrorSyncLock(async () => {
      const inner = await withMirrorSyncLock(async () => "inner");
      return inner.acquired;
    });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) expect(outcome.result).toBe(false);
  });

  it("boot reconciliation leaves technical lots untouched while the lock is held", async () => {
    const id = `lock-tech-${Date.now()}`;
    await db.insert(archidocTechnicalLots).values({
      archidocId: id,
      code: `LOCK-${Date.now()}`,
      labelFr: "Previous-source fixture",
      displayOrder: 1,
      isActive: true,
      deletedAt: null,
      sourceBaseUrl: "https://previous-archidoc.example.com",
      archidocCreatedAt: new Date(),
      archidocUpdatedAt: new Date(),
      syncedAt: new Date(),
    });
    try {
      const whileHeld = await holdLock(() => clearPreviousBackendMirrorRows());
      expect(whileHeld).toEqual({ projects: 0, contractors: 0, technicalLots: 0 });
      const [stillActive] = await db
        .select()
        .from(archidocTechnicalLots)
        .where(eq(archidocTechnicalLots.archidocId, id));
      expect(stillActive.isActive).toBe(true);
    } finally {
      await db
        .delete(archidocTechnicalLots)
        .where(eq(archidocTechnicalLots.archidocId, id));
    }
  });
});
