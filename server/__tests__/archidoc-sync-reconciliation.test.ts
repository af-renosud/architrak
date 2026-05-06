// Task #164 regression — full-sync reconciliation pass.
//
// Drives `syncProjects(false)` twice (with disjoint upstream
// responses) against the real database and asserts via
// `storage.getArchidocProjects()` that:
//
//   1. Set A is upserted and stamped with the current source backend.
//   2. After re-pointing the backend (env swap) AND running a second
//      full sync that returns only set B, set A is soft-deleted and
//      no longer visible through storage.
//   3. A pre-existing legacy row (NULL source_base_url) is also
//      cleared by the boot-time `clearPreviousBackendMirrorRows()`
//      pass.
//
// Uses unique `task164-*` archidoc_ids and cleans up in afterAll so
// the test is safe to run repeatedly against the dev database.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const envState: { ARCHIDOC_BASE_URL: string } = {
  ARCHIDOC_BASE_URL: "https://archidoc-prod.example.com",
};

vi.mock("../env", async () => {
  const actual = await vi.importActual<typeof import("../env")>("../env");
  // The real `env` is Object.freeze()'d, so a Proxy target on it
  // would violate the get-trap invariant when our override returns
  // a value different from the frozen property. Build a non-frozen
  // shallow copy and define ARCHIDOC_BASE_URL as a configurable
  // getter that resolves through `envState`.
  const mutable: Record<string, unknown> = { ...(actual.env as object) };
  Object.defineProperty(mutable, "ARCHIDOC_BASE_URL", {
    configurable: true,
    enumerable: true,
    get: () => envState.ARCHIDOC_BASE_URL,
  });
  return { ...actual, env: mutable };
});

const fetchProjectsMock = vi.fn();
vi.mock("../archidoc/sync-client", async () => {
  const actual =
    await vi.importActual<typeof import("../archidoc/sync-client")>(
      "../archidoc/sync-client",
    );
  return {
    ...actual,
    isArchidocConfigured: () => true,
    fetchProjects: fetchProjectsMock,
  };
});

const TEST_PREFIX = "task164-";

const skipModule = !process.env.DATABASE_URL;

describe.skipIf(skipModule)(
  "Task #164 — Archidoc mirror reconciliation (integration)",
  () => {
    const archidocIds = {
      legacyNull: `${TEST_PREFIX}legacy-null`,
      stalePrev: `${TEST_PREFIX}stale-prev`,
      setA1: `${TEST_PREFIX}A1`,
      setA2: `${TEST_PREFIX}A2`,
      setB1: `${TEST_PREFIX}B1`,
      setB2: `${TEST_PREFIX}B2`,
    };

    async function cleanup(): Promise<void> {
      const { db } = await import("../db");
      await db.execute(
        sql`DELETE FROM archidoc_projects WHERE archidoc_id LIKE ${`${TEST_PREFIX}%`}`,
      );
      await db.execute(
        sql`DELETE FROM archidoc_sync_log WHERE error_message LIKE ${`${TEST_PREFIX}%`} OR sync_type = 'projects'
          AND records_updated <= 2 AND started_at > now() - interval '1 minute'`,
      );
    }

    beforeAll(async () => {
      await cleanup();
      const { db } = await import("../db");
      const { archidocProjects } = await import("@shared/schema");

      // Seed two pre-existing rows that boot reconciliation should
      // clear: a legacy NULL-source row + a row stamped with the
      // previous backend's URL.
      await db.insert(archidocProjects).values([
        {
          archidocId: archidocIds.legacyNull,
          projectName: "Legacy NULL-source",
          sourceBaseUrl: null,
        },
        {
          archidocId: archidocIds.stalePrev,
          projectName: "From previous backend",
          sourceBaseUrl: "https://riker.replit.dev",
        },
      ]);
    }, 30_000);

    afterAll(async () => {
      await cleanup();
    });

    it(
      "boot reconciliation soft-deletes legacy + previous-backend rows",
      async () => {
        const { clearPreviousBackendMirrorRows } = await import(
          "../archidoc/sync-service"
        );
        const { storage } = await import("../storage");

        const result = await clearPreviousBackendMirrorRows();
        expect(result.projects).toBeGreaterThanOrEqual(2);

        const visible = await storage.getArchidocProjects();
        const visibleIds = visible.map((p) => p.archidocId);
        expect(visibleIds).not.toContain(archidocIds.legacyNull);
        expect(visibleIds).not.toContain(archidocIds.stalePrev);

        const all = await storage.getArchidocProjects({ includeDeleted: true });
        const audit = all.filter(
          (p) =>
            p.archidocId === archidocIds.legacyNull ||
            p.archidocId === archidocIds.stalePrev,
        );
        expect(audit).toHaveLength(2);
        for (const row of audit) {
          expect(row.isDeleted).toBe(true);
          expect(row.deletedAt).toBeInstanceOf(Date);
        }
      },
      30_000,
    );

    it(
      "full sync upserts set A and stamps source_base_url",
      async () => {
        const { syncProjects } = await import("../archidoc/sync-service");
        const { storage } = await import("../storage");

        fetchProjectsMock.mockResolvedValueOnce({
          projects: [
            {
              id: archidocIds.setA1,
              projectName: "Set A — first",
              status: "active",
            },
            {
              id: archidocIds.setA2,
              projectName: "Set A — second",
              status: "active",
            },
          ],
        });

        const result = await syncProjects(false);
        expect(result.error).toBeUndefined();
        expect(result.updated).toBe(2);

        const visible = await storage.getArchidocProjects();
        const visibleIds = visible.map((p) => p.archidocId);
        expect(visibleIds).toContain(archidocIds.setA1);
        expect(visibleIds).toContain(archidocIds.setA2);

        const all = await storage.getArchidocProjects({ includeDeleted: true });
        const a1 = all.find((p) => p.archidocId === archidocIds.setA1);
        expect(a1?.sourceBaseUrl).toBe("https://archidoc-prod.example.com");
        expect(a1?.isDeleted).toBe(false);
      },
      30_000,
    );

    it(
      "second full sync with disjoint set B soft-deletes set A",
      async () => {
        const { syncProjects } = await import("../archidoc/sync-service");
        const { storage } = await import("../storage");

        fetchProjectsMock.mockResolvedValueOnce({
          projects: [
            { id: archidocIds.setB1, projectName: "Set B — first" },
            { id: archidocIds.setB2, projectName: "Set B — second" },
          ],
        });

        const result = await syncProjects(false);
        expect(result.error).toBeUndefined();
        expect(result.updated).toBe(2);

        const visible = await storage.getArchidocProjects();
        const visibleIds = visible.map((p) => p.archidocId);

        // Set B is now visible.
        expect(visibleIds).toContain(archidocIds.setB1);
        expect(visibleIds).toContain(archidocIds.setB2);

        // Set A was missing from this response → reconciliation
        // soft-deleted it; it must no longer leak through storage.
        expect(visibleIds).not.toContain(archidocIds.setA1);
        expect(visibleIds).not.toContain(archidocIds.setA2);

        const all = await storage.getArchidocProjects({ includeDeleted: true });
        const a1 = all.find((p) => p.archidocId === archidocIds.setA1);
        expect(a1?.isDeleted).toBe(true);
        expect(a1?.deletedAt).toBeInstanceOf(Date);
      },
      30_000,
    );

    it(
      "re-asserting a previously soft-deleted row in a later full sync restores it",
      async () => {
        const { syncProjects } = await import("../archidoc/sync-service");
        const { storage } = await import("../storage");

        fetchProjectsMock.mockResolvedValueOnce({
          projects: [
            { id: archidocIds.setB1, projectName: "Set B — first" },
            { id: archidocIds.setB2, projectName: "Set B — second" },
            // setA1 returns from upstream — should be un-soft-deleted.
            { id: archidocIds.setA1, projectName: "Set A — first (restored)" },
          ],
        });

        const result = await syncProjects(false);
        expect(result.error).toBeUndefined();

        const visible = await storage.getArchidocProjects();
        const visibleIds = visible.map((p) => p.archidocId);
        expect(visibleIds).toContain(archidocIds.setA1);
        expect(visibleIds).not.toContain(archidocIds.setA2);

        const all = await storage.getArchidocProjects({ includeDeleted: true });
        const a1 = all.find((p) => p.archidocId === archidocIds.setA1);
        expect(a1?.isDeleted).toBe(false);
        expect(a1?.deletedAt).toBeNull();
        expect(a1?.projectName).toBe("Set A — first (restored)");
      },
      30_000,
    );

    it(
      "boot reconciliation is a no-op when ARCHIDOC_BASE_URL is unset",
      async () => {
        const { clearPreviousBackendMirrorRows } = await import(
          "../archidoc/sync-service"
        );
        const previous = envState.ARCHIDOC_BASE_URL;
        envState.ARCHIDOC_BASE_URL = "";
        try {
          const result = await clearPreviousBackendMirrorRows();
          expect(result).toEqual({ projects: 0, contractors: 0 });
        } finally {
          envState.ARCHIDOC_BASE_URL = previous;
        }
      },
    );
  },
);

describe("getCurrentSourceBaseUrl()", () => {
  it("canonicalises to lowercase origin (no path, no trailing slash)", async () => {
    const { getCurrentSourceBaseUrl } = await import(
      "../archidoc/sync-service"
    );

    envState.ARCHIDOC_BASE_URL = "HTTPS://Archidoc-Prod.Example.com/api/v1/";
    expect(getCurrentSourceBaseUrl()).toBe("https://archidoc-prod.example.com");

    envState.ARCHIDOC_BASE_URL = "https://riker.replit.dev";
    expect(getCurrentSourceBaseUrl()).toBe("https://riker.replit.dev");

    envState.ARCHIDOC_BASE_URL = "";
    expect(getCurrentSourceBaseUrl()).toBeNull();

    envState.ARCHIDOC_BASE_URL = "https://archidoc-prod.example.com";
  });
});
