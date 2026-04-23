import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #111 — verifies the upload service's page-hint coercion path:
// the AI extractor's `pageHint` field is propagated to `devis_line_items.
// pdf_page_hint` only when it's a strict positive integer; everything else
// (undefined, null, NaN, 0, negatives, non-numbers) is degraded to null so
// the contractor portal click-to-jump never fires on garbage data.

const { storageSpy } = vi.hoisted(() => ({
  storageSpy: {
    getProjects: vi.fn(),
    getContractors: vi.fn(),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createDevis: vi.fn(async () => ({ id: 999, devisCode: "D-999" })),
    createDevisLineItem: vi.fn(async () => ({ id: 1 })),
    getAiModelSetting: vi.fn(async () => null),
  },
}));

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../storage/object-storage", () => ({
  uploadDocument: vi.fn(async (_p: number, name: string) => `mock-key/${name}`),
}));
vi.mock("../middleware/upload", () => ({ assertPdfMagic: vi.fn() }));
vi.mock("../services/lot-reference-validator", () => ({
  checkLotReferencesAgainstCatalog: vi.fn(async () => []),
}));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(async () => undefined),
}));
vi.mock("../services/devis-translation", () => ({
  triggerDevisTranslation: vi.fn(),
}));
vi.mock("../gmail/document-parser", async (importOriginal) => {
  const original = await importOriginal<typeof import("../gmail/document-parser")>();
  return { ...original, parseDocument: vi.fn() };
});

import { processDevisUpload } from "../services/devis-upload.service";
import { parseDocument } from "../gmail/document-parser";

const parseDocumentMock = parseDocument as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  storageSpy.getProjects.mockResolvedValue([
    { id: 7, name: "P", code: "PROJ-007" },
  ]);
  storageSpy.getContractors.mockResolvedValue([
    { id: 11, name: "Acme", siret: "12345678900012", email: "a@e.com" },
  ]);
});

const mkFile = () => ({
  buffer: Buffer.from("%PDF-1.4 fake"),
  originalname: "devis.pdf",
  mimetype: "application/pdf",
  size: 12,
}) as unknown as Express.Multer.File;

describe("processDevisUpload — pdfPageHint coercion (Task #111)", () => {
  it("persists valid integer page hints and degrades invalid AI signals to null", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      contractorName: "Acme",
      siret: "12345678900012",
      amountHt: 5000,
      amountTtc: 6000,
      tvaAmount: 1000,
      tvaRate: 20,
      lineItems: [
        { description: "Line on page 1", total: 1000, pageHint: 1 },
        { description: "Line on page 3", total: 1000, pageHint: 3 },
        { description: "AI omitted hint", total: 1000 },                     // undefined → null
        { description: "AI emitted null", total: 1000, pageHint: null as unknown as number },
        { description: "AI emitted zero", total: 1000, pageHint: 0 },        // 0 invalid → null
        { description: "AI emitted negative", total: 1000, pageHint: -2 },   // <1 → null
        { description: "AI emitted float", total: 1000, pageHint: 2.7 },     // 2.7 → 2
        { description: "AI emitted NaN", total: 1000, pageHint: NaN },       // NaN → null
        { description: "AI emitted string", total: 1000, pageHint: "4" as unknown as number }, // wrong type → null
      ],
    });

    await processDevisUpload(7, mkFile());

    expect(storageSpy.createDevisLineItem).toHaveBeenCalledTimes(9);
    const calls = storageSpy.createDevisLineItem.mock.calls.map(([arg]: [{ pdfPageHint: number | null }]) => arg.pdfPageHint);
    expect(calls).toEqual([1, 3, null, null, null, null, 2, null, null]);
  });
});

describe("processDevisUpload — pdfBbox coercion (Task #113)", () => {
  it("persists valid normalized bboxes and degrades invalid AI signals to null", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      contractorName: "Acme",
      siret: "12345678900012",
      amountHt: 5000,
      amountTtc: 6000,
      tvaAmount: 1000,
      tvaRate: 20,
      lineItems: [
        // valid
        { description: "Tight in-page rect", total: 1, pageHint: 1, bbox: { x: 0.1, y: 0.2, w: 0.7, h: 0.05 } },
        // valid: AI rounded slightly above 1 — clamped, not rejected
        { description: "Slight overflow clamped", total: 1, pageHint: 1, bbox: { x: 0.0, y: 0.95, w: 1.001, h: 0.04 } },
        // missing
        { description: "AI omitted bbox", total: 1, pageHint: 1 },
        // null
        { description: "AI emitted null", total: 1, pageHint: 1, bbox: null as unknown as { x: number; y: number; w: number; h: number } },
        // partial / wrong shape
        { description: "Missing field", total: 1, pageHint: 1, bbox: { x: 0.1, y: 0.2, w: 0.5 } as unknown as { x: number; y: number; w: number; h: number } },
        // negative coord
        { description: "Negative origin", total: 1, pageHint: 1, bbox: { x: -0.1, y: 0.2, w: 0.5, h: 0.1 } },
        // zero area
        { description: "Zero height", total: 1, pageHint: 1, bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0 } },
        // off-page (way outside epsilon)
        { description: "Off-page", total: 1, pageHint: 1, bbox: { x: 0.5, y: 0.5, w: 0.9, h: 0.9 } },
        // NaN inside
        { description: "NaN", total: 1, pageHint: 1, bbox: { x: NaN, y: 0.2, w: 0.5, h: 0.1 } },
        // wrong types
        { description: "Strings", total: 1, pageHint: 1, bbox: { x: "0.1", y: 0.2, w: 0.5, h: 0.1 } as unknown as { x: number; y: number; w: number; h: number } },
      ],
    });

    await processDevisUpload(7, mkFile());

    expect(storageSpy.createDevisLineItem).toHaveBeenCalledTimes(10);
    const calls = storageSpy.createDevisLineItem.mock.calls.map(
      ([arg]: [{ pdfBbox: { x: number; y: number; w: number; h: number } | null }]) => arg.pdfBbox,
    );
    expect(calls[0]).toEqual({ x: 0.1, y: 0.2, w: 0.7, h: 0.05 });
    // The slight-overflow case is clamped to (1 - x) so the box fits.
    expect(calls[1]).toEqual({ x: 0, y: 0.95, w: 1, h: 0.04 });
    // Everything else degrades to null.
    expect(calls.slice(2)).toEqual([null, null, null, null, null, null, null, null]);
  });
});
