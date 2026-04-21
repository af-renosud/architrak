import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type {
  Devis,
  Lot,
  LotCatalog,
  Project,
  Contractor,
  ProjectDocument,
  DevisLineItem,
  BenchmarkDocument,
  BenchmarkItem,
} from "@shared/schema";

interface State {
  nextId: number;
  projects: Project[];
  contractors: Contractor[];
  lotCatalog: LotCatalog[];
  lots: Lot[];
  devis: Devis[];
  devisLineItems: DevisLineItem[];
  projectDocuments: ProjectDocument[];
  benchmarkDocuments: BenchmarkDocument[];
  benchmarkItems: BenchmarkItem[];
}

const { state, storageSpy, dbSpy } = vi.hoisted(() => {
  const state = {
    nextId: 200,
    projects: [],
    contractors: [],
    lotCatalog: [],
    lots: [],
    devis: [],
    devisLineItems: [],
    projectDocuments: [],
    benchmarkDocuments: [],
    benchmarkItems: [],
  } as unknown as State;
  const nid = () => state.nextId++;

  const storageSpy = {
    getProjects: vi.fn(async () => state.projects),
    getProject: vi.fn(async (id: number) => state.projects.find((p) => p.id === id)),
    getContractors: vi.fn(async () => state.contractors),
    getLotCatalogByCode: vi.fn(async (code: string) =>
      state.lotCatalog.find((e) => e.code === code.trim().toUpperCase()),
    ),
    getLotCatalog: vi.fn(async () => state.lotCatalog),
    createProjectDocument: vi.fn(async (data: Omit<ProjectDocument, "id">) => {
      const row = { id: nid(), ...data } as ProjectDocument;
      state.projectDocuments.push(row);
      return row;
    }),
    createDevis: vi.fn(async (data: Omit<Devis, "id">) => {
      const row = { id: nid(), ...data } as Devis;
      state.devis.push(row);
      return row;
    }),
    getDevis: vi.fn(async (id: number) => state.devis.find((d) => d.id === id)),
    updateDevis: vi.fn(async (id: number, data: Partial<Devis>) => {
      const row = state.devis.find((d) => d.id === id);
      if (!row) return undefined;
      Object.assign(row, data);
      return row;
    }),
    createDevisLineItem: vi.fn(async (data: Omit<DevisLineItem, "id">) => {
      const row = { id: nid(), ...data } as DevisLineItem;
      state.devisLineItems.push(row);
      return row;
    }),
    createLot: vi.fn(async (data: Omit<Lot, "id" | "createdAt">) => {
      const row = { id: nid(), createdAt: new Date(), ...data } as Lot;
      state.lots.push(row);
      return row;
    }),
    updateLot: vi.fn(async (id: number, data: Partial<Lot>) => {
      const row = state.lots.find((l) => l.id === id);
      if (!row) return undefined;
      Object.assign(row, data);
      return row;
    }),
    ensureProjectLotFromCatalog: vi.fn(
      async (projectId: number, catalogCode: string): Promise<Lot | undefined> => {
        const entry = state.lotCatalog.find(
          (e) => e.code === catalogCode.trim().toUpperCase(),
        );
        if (!entry) return undefined;
        const existing = state.lots.find(
          (l) => l.projectId === projectId && l.lotNumber === entry.code,
        );
        if (existing) {
          existing.descriptionFr = entry.descriptionFr;
          return existing;
        }
        const row: Lot = {
          id: nid(),
          projectId,
          lotNumber: entry.code,
          descriptionFr: entry.descriptionFr,
          descriptionUk: null,
          createdAt: new Date(),
        };
        state.lots.push(row);
        return row;
      },
    ),
    getAiModelSetting: vi.fn(async () => undefined),
    getBenchmarkTags: vi.fn(async () => []),
    setBenchmarkItemTags: vi.fn(async () => undefined),
  };

  // Minimal drizzle-shaped tx for confirmDevisAndMirror. Each fake table is
  // backed by a singleton row (or empty), so where-filter ignorance is safe;
  // a multi-row bucket would throw to surface unexpected query shapes.
  type Bucket = Record<string, unknown>[];
  const tableNameOf = (table: object): string => {
    const sym = Object.getOwnPropertySymbols(table).find((s) =>
      String(s).includes("Name"),
    );
    return sym ? String((table as Record<symbol, unknown>)[sym]) : "unknown";
  };
  const bucketOf = (table: object): Bucket => {
    switch (tableNameOf(table)) {
      case "devis": return state.devis as unknown as Bucket;
      case "benchmark_documents": return state.benchmarkDocuments as unknown as Bucket;
      case "benchmark_items": return state.benchmarkItems as unknown as Bucket;
      case "lots": return state.lots as unknown as Bucket;
      default: throw new Error(`fake db: unsupported table ${tableNameOf(table)}`);
    }
  };
  const requireSingleton = (bucket: Bucket, op: string) => {
    if (bucket.length > 1) {
      throw new Error(
        `fake db ${op}: ${bucket.length} candidate rows; this fixture expects at most 1`,
      );
    }
  };

  const updateBuilder = (table: object) => {
    let payload: Record<string, unknown> = {};
    const apply = () => {
      const bucket = bucketOf(table);
      requireSingleton(bucket, "update");
      if (bucket[0]) Object.assign(bucket[0], payload);
    };
    const b: Record<string, unknown> = {};
    b.set = (data: Record<string, unknown>) => { payload = data; return b; };
    b.where = (_f: unknown) => b;
    b.returning = () => {
      apply();
      const bucket = bucketOf(table);
      return Promise.resolve(bucket.slice(0, 1).map((r) => ({ ...r })));
    };
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try { apply(); resolve(undefined); } catch (e) { reject(e); }
    };
    return b;
  };

  const selectBuilder = () => {
    let table: object | null = null;
    let limitN: number | null = null;
    const b: Record<string, unknown> = {};
    b.from = (t: object) => { table = t; return b; };
    b.where = (_f: unknown) => b;
    b.limit = (n: number) => { limitN = n; return b; };
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try {
        if (!table) throw new Error("fake db select: missing from()");
        const bucket = bucketOf(table);
        const rows = limitN != null ? bucket.slice(0, limitN) : bucket.slice();
        resolve(rows.map((r) => ({ ...r })));
      } catch (e) { reject(e); }
    };
    return b;
  };

  const insertBuilder = (table: object) => {
    let values: Record<string, unknown>[] = [];
    const apply = () => {
      const bucket = bucketOf(table);
      const inserted = values.map((v) => {
        const row = { id: nid(), ...v };
        bucket.push(row);
        return row;
      });
      return inserted.map((r) => ({ ...r }));
    };
    const b: Record<string, unknown> = {};
    b.values = (v: Record<string, unknown> | Record<string, unknown>[]) => {
      values = Array.isArray(v) ? v : [v]; return b;
    };
    b.onConflictDoUpdate = (_: unknown) => b;
    b.returning = () => Promise.resolve(apply());
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try { apply(); resolve(undefined); } catch (e) { reject(e); }
    };
    return b;
  };

  const deleteBuilder = (table: object) => ({
    where: (_f: unknown) => {
      bucketOf(table).length = 0;
      return Promise.resolve(undefined);
    },
  });

  const tx = {
    update: vi.fn((table: object) => updateBuilder(table)),
    select: vi.fn(() => selectBuilder()),
    insert: vi.fn((table: object) => insertBuilder(table)),
    delete: vi.fn((table: object) => deleteBuilder(table)),
  };
  const dbSpy = {
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    update: tx.update,
    select: tx.select,
    insert: tx.insert,
    delete: tx.delete,
  };

  return { state, storageSpy, dbSpy };
});

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../db", () => ({ db: dbSpy, pool: {} }));
vi.mock("../storage/object-storage", () => ({
  uploadDocument: vi.fn(async (_p: number, name: string) => `mock-key/${name}`),
}));
vi.mock("../middleware/upload", () => ({
  assertPdfMagic: vi.fn(),
  upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));
vi.mock("../gmail/document-parser", () => ({
  parseDocument: vi.fn(async () => ({
    documentType: "quotation",
    contractorName: "ACME BTP",
    reference: "DEV-2026-001",
    devisNumber: "DEV-2026-001",
    date: "2026-04-01",
    amountHt: 1000,
    tvaRate: 20,
    amountTtc: 1200,
    description: "Test devis",
    lotReferences: ["Lot 7 - Electricite", "Lot 99 - Mystère"],
    lineItems: [
      { description: "Cabling", quantity: 10, unit: "m", unitPrice: 50, total: 500 },
      { description: "Outlets", quantity: 5, unit: "u", unitPrice: 100, total: 500 },
    ],
  })),
  matchToProject: vi.fn(async () => ({
    projectId: 1, contractorId: 1, confidence: 90, matchedFields: [],
  })),
  isTransientParseFailure: vi.fn(() => false),
  getParseFailureMessage: vi.fn(() => null),
  PdfPasswordProtectedError: class extends Error {},
}));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(async () => undefined),
  getAdvisoriesForDevis: vi.fn(async () => []),
  acknowledgeAdvisoryForSubject: vi.fn(async () => null),
}));
vi.mock("../services/benchmark-tags", () => ({
  normalizeUnit: (u: string | null) => u,
}));

import { processDevisUpload } from "../services/devis-upload.service";
import devisRouter from "../routes/devis";
import lotCatalogRouter from "../routes/lot-catalog";
import { errorHandler } from "../middleware/error-handler";
import type { ValidationWarning } from "../services/extraction-validator";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(devisRouter);
  app.use(lotCatalogRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function resetState() {
  state.nextId = 200;
  state.projects = [{ id: 1 } as Project];
  state.contractors = [{ id: 1 } as Contractor];
  state.lotCatalog = [
    { id: 1, code: "ELECTRICITE", descriptionFr: "Électricité", createdAt: new Date() },
    { id: 2, code: "GO", descriptionFr: "Gros œuvre", createdAt: new Date() },
  ];
  state.lots = [
    {
      id: 100,
      projectId: 1,
      lotNumber: "ELECTRICITE",
      descriptionFr: "Original electrical scope (do not overwrite)",
      descriptionUk: null,
      createdAt: new Date(),
    },
  ];
  state.devis = [];
  state.devisLineItems = [];
  state.projectDocuments = [];
  state.benchmarkDocuments = [];
  state.benchmarkItems = [];
  storageSpy.createLot.mockClear();
  storageSpy.updateLot.mockClear();
  storageSpy.ensureProjectLotFromCatalog.mockClear();
}

describe("devis confirm flow — lot pollution guard (integration)", () => {
  beforeEach(resetState);

  it("upload → real confirm → assign-from-catalog never creates or mutates project lots, and lotId is null until assignment", async () => {
    const lotsBefore = state.lots.map((l) => ({ ...l }));

    // Upload (calls real processDevisUpload).
    const upload = await processDevisUpload(1, {
      originalname: "devis.pdf",
      buffer: Buffer.from("%PDF-1.7 fake"),
      mimetype: "application/pdf",
    });
    expect(upload.success).toBe(true);
    const devisRow = (upload.data as { devis: Devis }).devis;
    expect(devisRow.lotId).toBeNull();

    const uploadLotWarnings = (devisRow.validationWarnings as ValidationWarning[]).filter(
      (w) => w.field === "lotReferences",
    );
    expect(uploadLotWarnings).toHaveLength(1);
    expect(uploadLotWarnings[0].actual).toBe("Lot 99 - Mystère");
    expect(uploadLotWarnings[0].message).toMatch(/needs new lot/i);

    expect(storageSpy.createLot).not.toHaveBeenCalled();
    expect(storageSpy.updateLot).not.toHaveBeenCalled();
    expect(state.lots).toEqual(lotsBefore);

    // Confirm via real HTTP route + real confirmDevisAndMirror service.
    const confirmResp = await fetch(`${baseUrl}/api/devis/${devisRow.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(confirmResp.status).toBe(200);
    const confirmed = (await confirmResp.json()) as Devis;
    expect(confirmed.status).toBe("pending");

    // Real mirror ran: benchmark tables populated.
    expect(state.benchmarkDocuments).toHaveLength(1);
    expect(state.benchmarkItems.length).toBeGreaterThan(0);

    // Lot table untouched.
    expect(storageSpy.createLot).not.toHaveBeenCalled();
    expect(storageSpy.updateLot).not.toHaveBeenCalled();
    expect(state.lots).toEqual(lotsBefore);

    const persisted = (await storageSpy.getDevis(devisRow.id)) as Devis;
    const persistedLotWarnings = (persisted.validationWarnings as ValidationWarning[]).filter(
      (w) => w.field === "lotReferences",
    );
    expect(persistedLotWarnings.some((w) => /needs new lot/i.test(w.message))).toBe(true);
    expect(persisted.lotId).toBeNull();

    // Strict confirm schema rejects a smuggled lotId. Suppress the
    // expected ZodError log so CI output stays clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const leak = await fetch(`${baseUrl}/api/devis/${devisRow.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lotId: 999 }),
    });
    errSpy.mockRestore();
    expect(leak.status).toBe(400);
    expect(((await storageSpy.getDevis(devisRow.id)) as Devis).lotId).toBeNull();
    expect(storageSpy.createLot).not.toHaveBeenCalled();
    expect(storageSpy.updateLot).not.toHaveBeenCalled();

    // assign-from-catalog is the only path allowed to set lotId.
    const assign = await fetch(
      `${baseUrl}/api/projects/1/lots/assign-from-catalog`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogCode: "ELECTRICITE", devisId: devisRow.id }),
      },
    );
    expect(assign.status).toBe(200);
    const { lot } = (await assign.json()) as { lot: Lot };
    expect(lot.id).toBe(100); // reused existing project lot, no new row
    expect(state.lots.filter((l) => l.lotNumber === "ELECTRICITE")).toHaveLength(1);
    expect(storageSpy.createLot).not.toHaveBeenCalled();

    const final = (await storageSpy.getDevis(devisRow.id)) as Devis;
    expect(final.lotId).toBe(lot.id);
  });

  it("never auto-creates a project lot when none exists yet, even if extraction matches a catalog code", async () => {
    state.lots = [];
    const lotsBefore = state.lots.slice();

    const upload = await processDevisUpload(1, {
      originalname: "devis.pdf",
      buffer: Buffer.from("%PDF-1.7 fake"),
      mimetype: "application/pdf",
    });
    expect(upload.success).toBe(true);
    const devisRow = (upload.data as { devis: Devis }).devis;
    expect(devisRow.lotId).toBeNull();
    expect(state.lots).toEqual(lotsBefore);

    const confirmResp = await fetch(`${baseUrl}/api/devis/${devisRow.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(confirmResp.status).toBe(200);

    expect(storageSpy.createLot).not.toHaveBeenCalled();
    expect(storageSpy.updateLot).not.toHaveBeenCalled();
    expect(state.lots).toEqual(lotsBefore);
    expect(((await storageSpy.getDevis(devisRow.id)) as Devis).lotId).toBeNull();
  });
});
