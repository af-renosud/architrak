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
const fetchTechnicalLotsMock = vi.fn();
vi.mock("../archidoc/sync-client", async () => {
  const actual =
    await vi.importActual<typeof import("../archidoc/sync-client")>(
      "../archidoc/sync-client",
    );
  return {
    ...actual,
    isArchidocConfigured: () => true,
    fetchProjects: fetchProjectsMock,
    fetchTechnicalLots: fetchTechnicalLotsMock,
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
          expect(result).toEqual({ projects: 0, contractors: 0, technicalLots: 0 });
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

describe.skipIf(skipModule).sequential(
  "ArchiDoc technical-lot mirror publication (integration)",
  () => {
    const prefix = `tech-sync-${Date.now()}-`;
    const existingId = `${prefix}existing`;
    let previousCatalogue: Record<string, unknown> | null = null;

    async function deleteFixtures(): Promise<void> {
      const { db } = await import("../db");
      await db.execute(
        sql`DELETE FROM archidoc_technical_lots WHERE archidoc_id LIKE ${`${prefix}%`}`,
      );
    }

    beforeAll(async () => {
      const { db } = await import("../db");
      const result = await db.execute(
        sql`SELECT singleton_key, revision, changed_at, source_base_url, synced_at
              FROM archidoc_technical_lot_catalogue
             WHERE singleton_key = 1`,
      );
      previousCatalogue = (result.rows[0] as Record<string, unknown> | undefined) ?? null;
      await deleteFixtures();
      await db.execute(sql`
        INSERT INTO archidoc_technical_lots
          (archidoc_id, code, label_fr, display_order, is_active, deleted_at,
           source_base_url, archidoc_created_at, archidoc_updated_at, synced_at)
        VALUES
          (${existingId}, ${`${prefix}CODE`}, 'Existing LKG', 1, true, NULL,
           'https://archidoc-prod.example.com', now(), now(), now())
      `);
      await db.execute(sql`
        INSERT INTO archidoc_technical_lot_catalogue
          (singleton_key, revision, changed_at, source_base_url, synced_at)
        VALUES
          (1, 700, '2024-01-01T00:00:00.000Z', 'https://archidoc-prod.example.com', now())
        ON CONFLICT (singleton_key) DO UPDATE SET
          revision = EXCLUDED.revision,
          changed_at = EXCLUDED.changed_at,
          source_base_url = EXCLUDED.source_base_url,
          synced_at = EXCLUDED.synced_at
      `);
    });

    afterAll(async () => {
      const { db } = await import("../db");
      await deleteFixtures();
      if (previousCatalogue) {
        await db.execute(sql`
          INSERT INTO archidoc_technical_lot_catalogue
            (singleton_key, revision, changed_at, source_base_url, synced_at)
          VALUES
            (${previousCatalogue.singleton_key}, ${previousCatalogue.revision},
             ${previousCatalogue.changed_at}, ${previousCatalogue.source_base_url},
             ${previousCatalogue.synced_at})
          ON CONFLICT (singleton_key) DO UPDATE SET
            revision = EXCLUDED.revision,
            changed_at = EXCLUDED.changed_at,
            source_base_url = EXCLUDED.source_base_url,
            synced_at = EXCLUDED.synced_at
        `);
      } else {
        await db.execute(
          sql`DELETE FROM archidoc_technical_lot_catalogue WHERE singleton_key = 1`,
        );
      }
    });

    it("preserves all last-known-good rows and catalogue metadata when upstream omits an ID", async () => {
      const { syncTechnicalLots } = await import("../archidoc/sync-service");
      const { db } = await import("../db");
      fetchTechnicalLotsMock.mockResolvedValueOnce({
        lots: [],
        catalogue: { revision: 701, changedAt: "2024-02-01T00:00:00.000Z" },
      });

      const result = await syncTechnicalLots();
      expect(result.error).toMatch(/omitted 1 previously-mirrored ID/);
      const lots = await db.execute(
        sql`SELECT label_fr, is_active FROM archidoc_technical_lots WHERE archidoc_id = ${existingId}`,
      );
      expect(lots.rows[0]).toMatchObject({ label_fr: "Existing LKG", is_active: true });
      const catalogue = await db.execute(
        sql`SELECT revision FROM archidoc_technical_lot_catalogue WHERE singleton_key = 1`,
      );
      expect(catalogue.rows[0]?.revision).toBe("700");
    });

    it("rolls back prior lot writes and catalogue publication when a later DB write fails", async () => {
      const { syncTechnicalLots } = await import("../archidoc/sync-service");
      const { db } = await import("../db");
      const firstNewId = `${prefix}first-new`;
      fetchTechnicalLotsMock.mockResolvedValueOnce({
        lots: [
          {
            id: existingId,
            code: `${prefix}CODE`,
            labelFr: "Existing LKG",
            displayOrder: 1,
            isActive: true,
            deletedAt: null,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
          {
            id: firstNewId,
            code: `${prefix}NEW`,
            labelFr: "Must roll back",
            displayOrder: 2,
            isActive: true,
            deletedAt: null,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
          {
            id: `${prefix}invalid`,
            code: `${prefix}INVALID`,
            labelFr: "Constraint failure",
            displayOrder: -1,
            isActive: true,
            deletedAt: null,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
        ],
        catalogue: { revision: 702, changedAt: "2024-03-01T00:00:00.000Z" },
      });

      const result = await syncTechnicalLots();
      expect(result.error).toBeTruthy();
      const rolledBack = await db.execute(
        sql`SELECT count(*) AS count FROM archidoc_technical_lots WHERE archidoc_id = ${firstNewId}`,
      );
      expect(rolledBack.rows[0]?.count).toBe("0");
      const catalogue = await db.execute(
        sql`SELECT revision FROM archidoc_technical_lot_catalogue WHERE singleton_key = 1`,
      );
      expect(catalogue.rows[0]?.revision).toBe("700");
    });

    it("rejects a backend ID collision that would overwrite immutable Planning history", async () => {
      const { syncTechnicalLots } = await import("../archidoc/sync-service");
      const { db } = await import("../db");
      const collisionId = `${prefix}referenced-collision`;
      const projectResult = await db.execute(sql`
        INSERT INTO projects (name, code, client_name)
        VALUES (${`${prefix}collision project`}, ${`${prefix}PROJECT`}, 'Integration client')
        RETURNING id
      `);
      const projectId = Number(projectResult.rows[0]?.id);
      try {
        await db.execute(sql`
          INSERT INTO archidoc_technical_lots
            (archidoc_id, code, label_fr, display_order, is_active, deleted_at,
             source_base_url, archidoc_created_at, archidoc_updated_at, synced_at)
          VALUES
            (${collisionId}, ${`${prefix}OLD`}, 'Historical identity', 2, false, now(),
             'https://previous-archidoc.example.com', now(), now(), now())
        `);
        const envelopeResult = await db.execute(sql`
          INSERT INTO planning_envelopes (project_id)
          VALUES (${projectId})
          RETURNING id
        `);
        const envelopeId = Number(envelopeResult.rows[0]?.id);
        await db.execute(sql`
          INSERT INTO planning_revisions
            (envelope_id, status, archidoc_technical_lot_id, reference,
             approved_by, approved_at, approved_snapshot, approved_snapshot_sha256)
          VALUES
            (${envelopeId}, 'approved', ${collisionId}, 'IMMUTABLE-COLLISION',
             'integration-test', now(), '{}'::jsonb, 'fixture-hash')
        `);

        fetchTechnicalLotsMock.mockResolvedValueOnce({
          lots: [
            {
              id: existingId,
              code: `${prefix}CODE`,
              labelFr: "Existing LKG",
              displayOrder: 1,
              isActive: true,
              deletedAt: null,
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
            },
            {
              id: collisionId,
              code: `${prefix}NEW`,
              labelFr: "Different identity from new backend",
              displayOrder: 2,
              isActive: true,
              deletedAt: null,
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-05-01T00:00:00.000Z",
            },
          ],
          catalogue: { revision: 704, changedAt: "2024-05-01T00:00:00.000Z" },
        });

        const result = await syncTechnicalLots();
        expect(result.error).toMatch(/Planning-referenced ID/);
        const preserved = await db.execute(sql`
          SELECT code, label_fr, source_base_url, is_active
            FROM archidoc_technical_lots
           WHERE archidoc_id = ${collisionId}
        `);
        expect(preserved.rows[0]).toMatchObject({
          code: `${prefix}OLD`,
          label_fr: "Historical identity",
          source_base_url: "https://previous-archidoc.example.com",
          is_active: false,
        });
        const catalogue = await db.execute(
          sql`SELECT revision FROM archidoc_technical_lot_catalogue WHERE singleton_key = 1`,
        );
        expect(catalogue.rows[0]?.revision).toBe("700");
      } finally {
        await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
        await db.execute(
          sql`DELETE FROM archidoc_technical_lots WHERE archidoc_id = ${collisionId}`,
        );
      }
    });

    it("publishes a complete response and catalogue together", async () => {
      const { syncTechnicalLots } = await import("../archidoc/sync-service");
      const { db } = await import("../db");
      const newId = `${prefix}published`;
      fetchTechnicalLotsMock.mockResolvedValueOnce({
        lots: [
          {
            id: existingId,
            code: `${prefix}CODE`,
            labelFr: "Existing refreshed",
            displayOrder: 1,
            isActive: true,
            deletedAt: null,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-04-01T00:00:00.000Z",
          },
          {
            id: newId,
            code: `${prefix}PUBLISHED`,
            labelFr: "Published atomically",
            displayOrder: 2,
            isActive: true,
            deletedAt: null,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-04-01T00:00:00.000Z",
          },
        ],
        catalogue: { revision: 703, changedAt: "2024-04-01T00:00:00.000Z" },
      });

      const result = await syncTechnicalLots();
      expect(result.error).toBeUndefined();
      expect(result.updated).toBe(2);
      const published = await db.execute(
        sql`SELECT label_fr FROM archidoc_technical_lots WHERE archidoc_id = ${newId}`,
      );
      expect(published.rows[0]?.label_fr).toBe("Published atomically");
      const catalogue = await db.execute(
        sql`SELECT revision FROM archidoc_technical_lot_catalogue WHERE singleton_key = 1`,
      );
      expect(catalogue.rows[0]?.revision).toBe("703");
    });
  },
);
