import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #340 — Integration coverage for the derived-totals draft warning
// (task #338) through the REAL upload path.
//
// The browser spec (tests/browser/derived-totals-draft-warning.spec.ts)
// seeds the warning directly in the database and proves the UI renders it.
// This test closes the remaining gap: it drives processDevisUpload with a
// mocked AI parse (amountHt/amountTtc both null, line items present) and the
// REAL validateExtraction + draft-persistence code, asserting the persisted
// draft row (the storage.createDevis payload) carries:
//   1. the `field: "amountHt"` derived-totals warning in validationWarnings,
//   2. aiConfidence capped at <= 40,
//   3. amountHt / amountTtc equal to the values derived from the line items.
// If a refactor ever drops the warning between the validator and the
// persisted validation_warnings column, this test fails.

const { storageSpy } = vi.hoisted(() => ({
  storageSpy: {
    getProjects: vi.fn(),
    getContractors: vi.fn(),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createDevis: vi.fn(async (row: Record<string, unknown>) => ({
      id: 999,
      devisCode: "D-999",
      projectId: row.projectId,
      lotId: null,
    })),
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
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn(async () => undefined),
}));
// Mock ONLY the AI parse — validateExtraction and the persistence path stay real.
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
  originalname: "devis-missing-totals.pdf",
  mimetype: "application/pdf",
  size: 12,
});

interface WarningShape {
  field: string;
  severity: string;
  message: string;
  expected: unknown;
  actual: unknown;
}

describe("processDevisUpload — derived-totals warning reaches the persisted draft (Task #340)", () => {
  it("null HT/TTC with line items → draft persisted with amountHt warning, confidence <= 40, derived amounts", async () => {
    // Mirrors the production incident behind task #338: every line item
    // extracted, both document totals null, 20% TVA rate extracted.
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      contractorName: "Acme",
      siret: "12345678900012",
      amountHt: null,
      amountTtc: null,
      tvaAmount: null,
      tvaRate: 20,
      lineItems: [
        { description: "Gros œuvre", total: 100000 },
        { description: "Charpente", total: 77000 },
        { description: "Menuiseries", total: 50000 },
      ],
    });

    const result = await processDevisUpload(7, mkFile());

    expect(result.status).toBe(201);
    expect(result.success).toBe(true);

    // The draft row handed to persistence (validation_warnings column).
    expect(storageSpy.createDevis).toHaveBeenCalledTimes(1);
    const row = storageSpy.createDevis.mock.calls[0][0] as {
      status: string;
      validationWarnings: WarningShape[];
      aiConfidence: number;
      amountHt: string;
      amountTtc: string;
    };

    expect(row.status).toBe("draft");

    // 1. The derived-totals warning survived validator → persisted row.
    const derivedWarning = row.validationWarnings.find(
      (w) => w.field === "amountHt",
    );
    expect(derivedWarning).toBeDefined();
    expect(derivedWarning!.severity).toBe("warning");
    expect(derivedWarning!.message).toContain(
      "Document totals were missing from the extraction",
    );
    expect(derivedWarning!.message).toContain("derived from the sum of 3 line items");
    expect(derivedWarning!.expected).toBe(227000);
    expect(derivedWarning!.actual).toBe(0);

    // 2. Confidence is capped so the draft visibly demands review.
    expect(row.aiConfidence).toBeLessThanOrEqual(40);

    // 3. Persisted amounts equal the derived values (HT = line sum,
    //    TTC = HT × 1.20 from the extracted TVA rate).
    expect(row.amountHt).toBe("227000");
    expect(row.amountTtc).toBe("272400");
  });

  it("TTC-underivable variant (no TVA rate): warning still persisted, TTC defaults to HT", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      contractorName: "Acme",
      siret: "12345678900012",
      amountHt: null,
      amountTtc: null,
      tvaAmount: null,
      tvaRate: null,
      lineItems: [
        { description: "Plomberie", total: 1200.5 },
        { description: "Électricité", total: 799.5 },
      ],
    });

    const result = await processDevisUpload(7, mkFile());
    expect(result.status).toBe(201);

    const row = storageSpy.createDevis.mock.calls[0][0] as {
      validationWarnings: WarningShape[];
      aiConfidence: number;
      amountHt: string;
      amountTtc: string;
    };

    const derivedWarning = row.validationWarnings.find((w) => w.field === "amountHt");
    expect(derivedWarning).toBeDefined();
    expect(derivedWarning!.message).toContain("TTC could not be derived");
    expect(row.aiConfidence).toBeLessThanOrEqual(40);
    expect(row.amountHt).toBe("2000");
    // TVA-neutral defaulting: with no derivable TTC, the missing side
    // defaults to the available HT (effective 0% TVA) — never €0.00.
    expect(row.amountTtc).toBe("2000");
  });
});
