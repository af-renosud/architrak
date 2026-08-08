import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #341 — Integration coverage for the derived-totals draft warning
// through the REAL invoice upload path.
//
// Mirrors server/__tests__/devis-upload-derived-totals.integration.test.ts
// (task #340), which covers the devis path. This test drives
// processInvoiceUpload with a mocked AI parse (amountHt/amountTtc both null,
// line items present) and the REAL validateExtraction + persistence code,
// asserting the persisted invoice row (the storage.createInvoice payload)
// carries:
//   1. the `field: "amountHt"` derived-totals warning in validationWarnings,
//   2. aiConfidence capped at <= 40,
//   3. amountHt / amountTtc equal to the values derived from the line items.
// If a refactor ever drops the warning between the validator and invoice
// persistence, this test fails.

const { storageSpy } = vi.hoisted(() => ({
  storageSpy: {
    getDevis: vi.fn(),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createInvoice: vi.fn(async (row: Record<string, unknown>) => ({
      id: 555,
      invoiceNumber: row.invoiceNumber,
      projectId: row.projectId,
    })),
    revokeDevisCheckTokenIfFullyInvoiced: vi.fn(async () => undefined),
    updateDevis: vi.fn(async () => undefined),
  },
}));

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../storage/object-storage", () => ({
  uploadDocument: vi.fn(async (_p: number, name: string) => `mock-key/${name}`),
}));
vi.mock("../middleware/upload", () => ({ assertPdfMagic: vi.fn() }));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(async () => undefined),
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn(async () => undefined),
}));
// Mock ONLY the AI parse — validateExtraction and the persistence path stay real.
vi.mock("../gmail/document-parser", async (importOriginal) => {
  const original = await importOriginal<typeof import("../gmail/document-parser")>();
  return { ...original, parseDocument: vi.fn() };
});

import { processInvoiceUpload } from "../services/invoice-upload.service";
import { parseDocument } from "../gmail/document-parser";

const parseDocumentMock = parseDocument as unknown as ReturnType<typeof vi.fn>;

const DEVIS = {
  id: 7,
  devisCode: "DVP0000661",
  projectId: 3,
  contractorId: 11,
  lotId: null,
  acompteRequired: false,
  acompteState: "not_required",
};

beforeEach(() => {
  vi.clearAllMocks();
  storageSpy.getDevis.mockResolvedValue(DEVIS);
});

const mkFile = () => ({
  buffer: Buffer.from("%PDF-1.4 fake"),
  originalname: "invoice-missing-totals.pdf",
  mimetype: "application/pdf",
});

interface WarningShape {
  field: string;
  severity: string;
  message: string;
  expected: unknown;
  actual: unknown;
}

describe("processInvoiceUpload — derived-totals warning reaches the persisted invoice (Task #341)", () => {
  it("null HT/TTC with line items → invoice persisted with amountHt warning, confidence <= 40, derived amounts", async () => {
    // Mirrors the production incident behind task #338: every line item
    // extracted, both document totals null, 20% TVA rate extracted.
    parseDocumentMock.mockResolvedValue({
      documentType: "invoice",
      contractorName: "Acme",
      invoiceNumber: "FA-2026-042",
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

    const result = await processInvoiceUpload(DEVIS.id, mkFile());

    expect(result.status).toBe(201);
    expect(result.success).toBe(true);

    // The invoice row handed to persistence (validation_warnings column).
    expect(storageSpy.createInvoice).toHaveBeenCalledTimes(1);
    const row = storageSpy.createInvoice.mock.calls[0][0] as {
      status: string;
      validationWarnings: WarningShape[];
      aiConfidence: number;
      amountHt: string;
      amountTtc: string;
      tvaAmount: string;
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
    //    TTC = HT × 1.20 from the extracted TVA rate, TVA = TTC − HT).
    expect(row.amountHt).toBe("227000");
    expect(row.amountTtc).toBe("272400");
    expect(row.tvaAmount).toBe("45400");

    // Since both sides were derived, no missing-total error should be added
    // by the upload service's HT/TTC completeness check.
    expect(
      row.validationWarnings.some((w) => w.severity === "error"),
    ).toBe(false);
  });

  it("TTC-underivable variant (no TVA rate): warning still persisted, TTC defaults to HT, missing-pair error added", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "invoice",
      contractorName: "Acme",
      invoiceNumber: "FA-2026-043",
      amountHt: null,
      amountTtc: null,
      tvaAmount: null,
      tvaRate: null,
      lineItems: [
        { description: "Plomberie", total: 1200.5 },
        { description: "Électricité", total: 799.5 },
      ],
    });

    const result = await processInvoiceUpload(DEVIS.id, mkFile());
    expect(result.status).toBe(201);

    const row = storageSpy.createInvoice.mock.calls[0][0] as {
      validationWarnings: WarningShape[];
      aiConfidence: number;
      amountHt: string;
      amountTtc: string;
    };

    const derivedWarning = row.validationWarnings.find(
      (w) => w.field === "amountHt" && w.severity === "warning",
    );
    expect(derivedWarning).toBeDefined();
    expect(derivedWarning!.message).toContain("TTC could not be derived");
    expect(row.aiConfidence).toBeLessThanOrEqual(40);
    expect(row.amountHt).toBe("2000");
    // TVA-neutral defaulting: with no derivable TTC, the missing side
    // mirrors the available HT (derived TVA = 0) — never €0.00.
    expect(row.amountTtc).toBe("2000");
  });
});
