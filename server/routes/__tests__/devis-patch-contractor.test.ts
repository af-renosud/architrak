import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

vi.mock("../../storage", () => ({
  storage: {
    getUser: vi.fn(),
    getDevis: vi.fn(),
    getProject: vi.fn(),
    getContractor: vi.fn(),
    updateDevis: vi.fn(),
    createDevisRefEdit: vi.fn(),
    getDevisRefEdits: vi.fn(),
    getDevisByProject: vi.fn(),
    getDevisTranslation: vi.fn(),
    updateDevisTranslation: vi.fn(),
    createDevis: vi.fn(),
    getDevisLineItems: vi.fn(),
    createDevisLineItem: vi.fn(),
    updateDevisLineItem: vi.fn(),
    deleteDevisLineItem: vi.fn(),
    getAvenantsByDevis: vi.fn(),
    createAvenant: vi.fn(),
    updateAvenant: vi.fn(),
  },
}));

vi.mock("../../auth/middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  },
}));

vi.mock("../../services/devis-upload.service", () => ({ processDevisUpload: vi.fn() }));
vi.mock("../../services/benchmark-ingest.service", () => ({
  confirmDevisAndMirror: vi.fn(),
  assignTagsForInsertedItems: vi.fn(),
}));
vi.mock("../../services/extraction-validator", () => ({ validateExtraction: vi.fn() }));
vi.mock("../../services/lot-reference-validator", () => ({ checkLotReferencesAgainstCatalog: vi.fn() }));
vi.mock("../../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(),
  getAdvisoriesForDevis: vi.fn(),
  acknowledgeAdvisoryForSubject: vi.fn(),
}));
vi.mock("../../services/devis-translation", () => ({
  translateDevis: vi.fn(),
  retranslateSingleLine: vi.fn(),
  triggerDevisTranslation: vi.fn(),
}));
vi.mock("../../communications/devis-translation-generator", () => ({
  generateDevisTranslationPdf: vi.fn(),
  generateCombinedPdf: vi.fn(),
}));
vi.mock("../../storage/object-storage", () => ({ getDocumentStream: vi.fn() }));
vi.mock("../../middleware/upload", () => ({ upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() } }));

import devisRouter from "../devis";
import { storage } from "../../storage";

const getUser = storage.getUser as unknown as ReturnType<typeof vi.fn>;
const getDevis = storage.getDevis as unknown as ReturnType<typeof vi.fn>;
const getProject = storage.getProject as unknown as ReturnType<typeof vi.fn>;
const getContractor = storage.getContractor as unknown as ReturnType<typeof vi.fn>;
const updateDevis = storage.updateDevis as unknown as ReturnType<typeof vi.fn>;
const createDevisRefEdit = storage.createDevisRefEdit as unknown as ReturnType<typeof vi.fn>;

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(devisRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ message });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ id: 1, email: "tester@renosud.com" });
});

function makeDevis(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    projectId: 9,
    contractorId: 7,
    status: "pending",
    devisCode: "GRACE_1348_1",
    devisNumber: "DV1",
    ref2: null,
    amountHt: "1000.00",
    amountTtc: "1200.00",
    ...overrides,
  };
}

function makeContractor(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: "SAS AT TRAVAUX",
    siret: null,
    archidocOrphanedAt: null,
    archidocId: null,
    ...overrides,
  };
}

describe("PATCH /api/devis/:id contractor change", () => {
  it("updates contractor and writes audit row with prev/new names", async () => {
    getDevis.mockResolvedValue(makeDevis());
    getProject.mockResolvedValue({ id: 9, archivedAt: null });
    getContractor.mockImplementation(async (id: number) => {
      if (id === 42) return makeContractor({ id: 42, name: "SAS AT TRAVAUX" });
      if (id === 7) return makeContractor({ id: 7, name: "AT PISCINES" });
      return undefined;
    });
    updateDevis.mockResolvedValue(makeDevis({ contractorId: 42 }));
    createDevisRefEdit.mockResolvedValue({ id: 1 });

    const res = await fetch(`${baseUrl}/api/devis/100`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId: 42 }),
    });
    expect(res.status).toBe(200);
    expect(updateDevis).toHaveBeenCalledWith(100, { contractorId: 42 });
    expect(createDevisRefEdit).toHaveBeenCalledTimes(1);
    expect(createDevisRefEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        devisId: 100,
        field: "contractorId",
        previousValue: "7:AT PISCINES",
        newValue: "42:SAS AT TRAVAUX",
        editedByUserId: 1,
        editedByEmail: "tester@renosud.com",
      }),
    );
  });

  it("rejects unknown contractor id", async () => {
    getDevis.mockResolvedValue(makeDevis());
    getProject.mockResolvedValue({ id: 9, archivedAt: null });
    getContractor.mockResolvedValue(undefined);

    const res = await fetch(`${baseUrl}/api/devis/100`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId: 999 }),
    });
    expect(res.status).toBe(404);
    expect(updateDevis).not.toHaveBeenCalled();
    expect(createDevisRefEdit).not.toHaveBeenCalled();
  });

  it("rejects orphaned contractor", async () => {
    getDevis.mockResolvedValue(makeDevis());
    getProject.mockResolvedValue({ id: 9, archivedAt: null });
    getContractor.mockResolvedValue(makeContractor({ id: 42, archidocOrphanedAt: new Date() }));

    const res = await fetch(`${baseUrl}/api/devis/100`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId: 42 }),
    });
    expect(res.status).toBe(409);
    expect(updateDevis).not.toHaveBeenCalled();
  });

  it("rejects contractor change on void devis", async () => {
    getDevis.mockResolvedValue(makeDevis({ status: "void" }));

    const res = await fetch(`${baseUrl}/api/devis/100`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId: 42 }),
    });
    expect(res.status).toBe(409);
    expect(getContractor).not.toHaveBeenCalled();
    expect(updateDevis).not.toHaveBeenCalled();
  });

  it("rejects contractor change on archived project", async () => {
    getDevis.mockResolvedValue(makeDevis());
    getProject.mockResolvedValue({ id: 9, archivedAt: new Date() });

    const res = await fetch(`${baseUrl}/api/devis/100`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId: 42 }),
    });
    expect(res.status).toBe(409);
    expect(updateDevis).not.toHaveBeenCalled();
  });

  it("audits contractor change on draft devis (no ref-code audit on drafts)", async () => {
    getDevis.mockResolvedValue(makeDevis({ status: "draft" }));
    getProject.mockResolvedValue({ id: 9, archivedAt: null });
    getContractor.mockImplementation(async (id: number) => {
      if (id === 42) return makeContractor({ id: 42, name: "SAS AT TRAVAUX" });
      if (id === 7) return makeContractor({ id: 7, name: "AT PISCINES" });
      return undefined;
    });
    updateDevis.mockResolvedValue(makeDevis({ status: "draft", contractorId: 42 }));

    const res = await fetch(`${baseUrl}/api/devis/100`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId: 42 }),
    });
    expect(res.status).toBe(200);
    expect(createDevisRefEdit).toHaveBeenCalledTimes(1);
    expect(createDevisRefEdit).toHaveBeenCalledWith(
      expect.objectContaining({ field: "contractorId" }),
    );
  });

  it("supports revert round-trip from audit previousValue", async () => {
    // Simulate the client-side revert flow: an audit row has previousValue
    // "7:AT PISCINES" from when the contractor was changed away from 7.
    // Reverting parses out id=7 and PATCHes contractorId: 7. The server
    // must accept that payload and write a new audit row going back.
    getDevis.mockResolvedValue(makeDevis({ contractorId: 42 }));
    getProject.mockResolvedValue({ id: 9, archivedAt: null });
    getContractor.mockImplementation(async (id: number) => {
      if (id === 42) return makeContractor({ id: 42, name: "SAS AT TRAVAUX" });
      if (id === 7) return makeContractor({ id: 7, name: "AT PISCINES" });
      return undefined;
    });
    updateDevis.mockResolvedValue(makeDevis({ contractorId: 7 }));

    const previousValue = "7:AT PISCINES";
    const colon = previousValue.indexOf(":");
    const revertId = Number(previousValue.slice(0, colon));

    const res = await fetch(`${baseUrl}/api/devis/100`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId: revertId }),
    });
    expect(res.status).toBe(200);
    expect(updateDevis).toHaveBeenCalledWith(100, { contractorId: 7 });
    expect(createDevisRefEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        field: "contractorId",
        previousValue: "42:SAS AT TRAVAUX",
        newValue: "7:AT PISCINES",
      }),
    );
  });

  it("audits both contractor and ref code in a single combined PATCH on non-draft", async () => {
    getDevis.mockResolvedValue(makeDevis({ status: "pending", contractorId: 7, devisCode: "OLD_CODE" }));
    getProject.mockResolvedValue({ id: 9, archivedAt: null });
    getContractor.mockImplementation(async (id: number) => {
      if (id === 42) return makeContractor({ id: 42, name: "SAS AT TRAVAUX" });
      if (id === 7) return makeContractor({ id: 7, name: "AT PISCINES" });
      return undefined;
    });
    updateDevis.mockResolvedValue(makeDevis({ contractorId: 42, devisCode: "NEW_CODE" }));

    const res = await fetch(`${baseUrl}/api/devis/100`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId: 42, devisCode: "NEW_CODE" }),
    });
    expect(res.status).toBe(200);
    expect(createDevisRefEdit).toHaveBeenCalledTimes(2);
    const fields = createDevisRefEdit.mock.calls.map((c) => (c[0] as { field: string }).field);
    expect(fields).toContain("contractorId");
    expect(fields).toContain("devisCode");
  });

  it("does nothing when contractorId equals current value", async () => {
    getDevis.mockResolvedValue(makeDevis({ contractorId: 7 }));
    updateDevis.mockResolvedValue(makeDevis({ contractorId: 7 }));

    const res = await fetch(`${baseUrl}/api/devis/100`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId: 7 }),
    });
    expect(res.status).toBe(200);
    expect(getContractor).not.toHaveBeenCalled();
    expect(createDevisRefEdit).not.toHaveBeenCalled();
  });
});
