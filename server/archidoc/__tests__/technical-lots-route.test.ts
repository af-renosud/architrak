import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

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
    technicalLots: { lastSync: null, lastSyncStatus: null, lastSyncError: null, count: null },
  }),
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
    // Wire up the select chain so successive calls return the right data.
    // The route issues 3 selects: lots, catalogue, syncLog.
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeQueryChain([SAMPLE_LOT]);
      if (callCount === 2) return makeQueryChain([SAMPLE_CATALOGUE]);
      return makeQueryChain([SAMPLE_SYNC_LOG]);
    });

    const res = await fetch(`${baseUrl}/api/archidoc/technical-lots`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      lots: typeof SAMPLE_LOT[];
      catalogue: typeof SAMPLE_CATALOGUE | null;
      sync: { status: string; recordsUpdated: number } | null;
    };
    expect(body.lots).toHaveLength(1);
    expect((body.lots[0] as unknown as { id: string }).id).toBe("lot-1");
    expect(body.catalogue).not.toBeNull();
    expect(body.catalogue?.revision).toBe(3);
    expect(body.sync?.status).toBe("completed");
    expect(body.sync?.recordsUpdated).toBe(1);
  });

  it("returns empty lots and null catalogue/sync on first boot", async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      // lots, catalogue, syncLog — all empty
      return makeQueryChain([]);
    });

    const res = await fetch(`${baseUrl}/api/archidoc/technical-lots`);
    expect(res.status).toBe(200);
    const body = await res.json() as { lots: unknown[]; catalogue: null; sync: null };
    expect(body.lots).toHaveLength(0);
    expect(body.catalogue).toBeNull();
    expect(body.sync).toBeNull();
  });

  it("returns 500 when the db throws", async () => {
    mockSelect.mockImplementation(() => {
      throw new Error("DB connection lost");
    });

    const res = await fetch(`${baseUrl}/api/archidoc/technical-lots`);
    expect(res.status).toBe(500);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/DB connection lost/);
  });
});
