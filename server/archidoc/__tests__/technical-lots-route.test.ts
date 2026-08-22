import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

const { getTechnicalLotsCatalogueSnapshotMock } = vi.hoisted(() => ({
  getTechnicalLotsCatalogueSnapshotMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that transitively load the
// modules being mocked (Vitest hoists vi.mock calls automatically).
// ---------------------------------------------------------------------------

vi.mock("../../db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("../../storage", () => ({
  storage: {
    getArchidocProjects: vi.fn().mockResolvedValue([]),
    getArchidocContractors: vi.fn().mockResolvedValue([]),
    getTrackedArchidocProjectIds: vi.fn().mockResolvedValue([]),
    getArchidocSiretIssues: vi.fn().mockResolvedValue([]),
    getArchidocProposalFees: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../archidoc/sync-client", () => ({
  isArchidocConfigured: vi.fn().mockReturnValue(false),
  getConnectionStatus: vi.fn().mockResolvedValue({ connected: false, checkedAt: new Date().toISOString() }),
}));

vi.mock("../../archidoc/sync-service", () => ({
  fullSync: vi.fn(),
  incrementalSync: vi.fn(),
  getLastSyncStatus: vi.fn().mockResolvedValue({
    configured: false,
    lastSync: null,
    lastSyncType: null,
    lastSyncStatus: null,
    lastSyncError: null,
    technicalLots: {
      lastSync: null,
      lastSyncStatus: null,
      lastSyncError: null,
      count: null,
      activeCount: null,
      catalogueState: "empty",
      selectable: false,
      catalogueRevision: null,
      catalogueChangedAt: null,
      catalogueSyncedAt: null,
      diagnosticReason: "The ArchiDoc technical-lot sync credential is not configured.",
      lastFetch: null,
    },
  }),
  getTechnicalLotsCatalogueSnapshot: getTechnicalLotsCatalogueSnapshotMock,
  getCurrentSourceBaseUrl: vi.fn().mockReturnValue(null),
  isMirrorSyncInProgress: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../archidoc/import-service", () => ({
  trackProject: vi.fn(),
  refreshProject: vi.fn(),
}));

vi.mock("../../env", () => ({
  env: {
    NODE_ENV: "test",
    ARCHIDOC_BASE_URL: "",
    ARCHIDOC_SYNC_API_KEY: "",
    ARCHIDOC_WEBHOOK_SECRET: "",
    ARCHIDOC_POLLING_ENABLED: false,
  },
  detectMisconfiguredArchidocBaseUrl: vi.fn().mockReturnValue(null),
}));

vi.mock("../../storage/object-storage", () => ({
  moveDocument: vi.fn(),
  buildDesignContractActiveObjectName: vi.fn(),
  isStagingKeyOwnedBy: vi.fn().mockReturnValue(false),
}));

vi.mock("../../services/design-contract-parser", () => ({
  validateConfirmedSchedule: vi.fn(),
}));

// ---------------------------------------------------------------------------
// After mocks are declared, import the db mock so we can configure it
// ---------------------------------------------------------------------------
import { db } from "../../db";

const mockSelect = db.select as ReturnType<typeof vi.fn>;

// Helpers to build a chainable drizzle-style query mock.
function makeQueryChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "where", "orderBy", "limit"];
  for (const m of methods) {
    chain[m] = () => chain;
  }
  // The final awaited value
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const { default: router } = await import("../../../server/routes/archidoc");
  const app = express();
  app.use(express.json());
  // Inject a session so requireAuth middleware (if present) passes.
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId?: number } }).session = { userId: 1 };
    next();
  });
  app.use(router);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SAMPLE_LOT = {
  archidocId: "lot-1",
  code: "01",
  labelFr: "Gros œuvre",
  displayOrder: 1,
  isActive: true,
  deletedAt: null,
  archidocCreatedAt: new Date("2024-01-01"),
  archidocUpdatedAt: new Date("2024-06-01"),
  sourceBaseUrl: "https://archidoc.example.com",
  syncedAt: new Date("2024-06-01"),
};

const SAMPLE_CATALOGUE = {
  singletonKey: 1,
  revision: 3,
  changedAt: new Date("2024-06-01"),
  sourceBaseUrl: "https://archidoc.example.com",
  syncedAt: new Date("2024-06-01"),
};

const SAMPLE_SYNC_LOG = {
  id: 10,
  syncType: "technical_lots",
  status: "completed",
  startedAt: new Date("2024-06-01T10:00:00Z"),
  completedAt: new Date("2024-06-01T10:00:05Z"),
  recordsUpdated: 1,
  malformedSiretCount: 0,
  errorMessage: null,
};

describe("GET /api/archidoc/technical-lots", () => {
  it("returns lots, catalogue, and sync status when mirror is populated", async () => {
    getTechnicalLotsCatalogueSnapshotMock.mockResolvedValueOnce({
      lots: [SAMPLE_LOT],
      catalogue: SAMPLE_CATALOGUE,
      syncLog: SAMPLE_SYNC_LOG,
      availability: {
        state: "ready",
        selectable: true,
        reason: null,
        lotCount: 1,
        activeLotCount: 1,
        revision: 3,
        changedAt: SAMPLE_CATALOGUE.changedAt,
        syncedAt: SAMPLE_CATALOGUE.syncedAt,
        lastFetch: {
          endpoint: "/api/integrations/architrak/technical-lots",
          outcome: "success",
          status: 200,
          durationMs: 125,
          checkedAt: "2024-06-01T10:00:05.000Z",
          code: null,
          reason: "Validated 1 technical-lot records.",
        },
      },
    });

    const res = await fetch(`${baseUrl}/api/archidoc/technical-lots`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      lots: typeof SAMPLE_LOT[];
      catalogue: typeof SAMPLE_CATALOGUE | null;
      sync: { status: string; recordsUpdated: number } | null;
      availability: { state: string; selectable: boolean; lastFetch: { status: number } };
    };
    expect(body.lots).toHaveLength(1);
    expect((body.lots[0] as unknown as { id: string }).id).toBe("lot-1");
    expect(body.catalogue).not.toBeNull();
    expect(body.catalogue?.revision).toBe(3);
    expect(body.sync?.status).toBe("completed");
    expect(body.sync?.recordsUpdated).toBe(1);
    expect(body.availability).toMatchObject({
      state: "ready",
      selectable: true,
      lastFetch: { status: 200 },
    });
  });

  it("returns an explicit empty-cache diagnostic on first boot", async () => {
    getTechnicalLotsCatalogueSnapshotMock.mockResolvedValueOnce({
      lots: [],
      catalogue: null,
      syncLog: null,
      availability: {
        state: "empty",
        selectable: false,
        reason: "The ArchiDoc technical-lot sync credential is not configured.",
        lotCount: 0,
        activeLotCount: 0,
        revision: null,
        changedAt: null,
        syncedAt: null,
        lastFetch: null,
      },
    });

    const res = await fetch(`${baseUrl}/api/archidoc/technical-lots`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      lots: unknown[];
      catalogue: null;
      sync: null;
      availability: { state: string; selectable: boolean; reason: string };
    };
    expect(body.lots).toHaveLength(0);
    expect(body.catalogue).toBeNull();
    expect(body.sync).toBeNull();
    expect(body.availability).toMatchObject({
      state: "empty",
      selectable: false,
      reason: "The ArchiDoc technical-lot sync credential is not configured.",
    });
  });

  it("keeps last-known-good catalogue selectable after a failed refresh", async () => {
    getTechnicalLotsCatalogueSnapshotMock.mockResolvedValueOnce({
      lots: [SAMPLE_LOT],
      catalogue: SAMPLE_CATALOGUE,
      syncLog: { ...SAMPLE_SYNC_LOG, status: "failed", recordsUpdated: 0 },
      availability: {
        state: "last_known_good",
        selectable: true,
        reason: "ArchiDoc is temporarily unavailable.",
        lotCount: 1,
        activeLotCount: 1,
        revision: 3,
        changedAt: SAMPLE_CATALOGUE.changedAt,
        syncedAt: SAMPLE_CATALOGUE.syncedAt,
        lastFetch: {
          endpoint: "/api/integrations/architrak/technical-lots",
          outcome: "error",
          status: 503,
          durationMs: 80,
          checkedAt: "2024-06-01T11:00:00.000Z",
          code: "unavailable",
          reason: "ArchiDoc is temporarily unavailable.",
        },
      },
    });

    const res = await fetch(`${baseUrl}/api/archidoc/technical-lots`);
    const body = await res.json() as {
      sync: { errorMessage: string };
      availability: { state: string; selectable: boolean; lastFetch: { code: string } };
    };
    expect(res.status).toBe(200);
    expect(body.availability).toMatchObject({
      state: "last_known_good",
      selectable: true,
      lastFetch: { code: "unavailable" },
    });
    expect(body.sync.errorMessage).toBe("ArchiDoc is temporarily unavailable.");
  });

  it("returns 500 when the catalogue snapshot fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getTechnicalLotsCatalogueSnapshotMock.mockRejectedValueOnce(
      new Error("DB connection lost with unit-test-bearer-secret"),
    );

    const res = await fetch(`${baseUrl}/api/archidoc/technical-lots`);
    expect(res.status).toBe(500);
    const body = await res.json() as { message: string };
    expect(body.message).toBe("Failed to get technical lots.");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("unit-test-bearer-secret");
  });
});
