import { describe, it, expect, vi, beforeEach } from "vitest";

const { storageSpy } = vi.hoisted(() => ({
  storageSpy: {
    getProjects: vi.fn(),
    getContractors: vi.fn(),
    createProjectDocument: vi.fn(async () => ({ id: 1 })),
    createDevis: vi.fn(),
    createDevisLineItem: vi.fn(),
    getAiModelSetting: vi.fn(async () => null),
  },
}));

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../storage/object-storage", () => ({
  uploadDocument: vi.fn(async (_p: number, name: string) => `mock-key/${name}`),
}));
vi.mock("../middleware/upload", () => ({
  assertPdfMagic: vi.fn(),
}));
vi.mock("../services/lot-reference-validator", () => ({
  checkLotReferencesAgainstCatalog: vi.fn(async () => []),
}));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(async () => undefined),
}));
vi.mock("../services/devis-translation", () => ({
  triggerDevisTranslation: vi.fn(),
}));

// We let the REAL matchToProject + extraction-validator run; only stub the AI
// extraction so it returns a controlled ParsedDocument.
vi.mock("../gmail/document-parser", async (importOriginal) => {
  const original = await importOriginal<typeof import("../gmail/document-parser")>();
  return {
    ...original,
    parseDocument: vi.fn(),
  };
});

import { processDevisUpload } from "../services/devis-upload.service";
import { parseDocument } from "../gmail/document-parser";

const parseDocumentMock = parseDocument as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  parseDocumentMock.mockReset();
  storageSpy.getProjects.mockReset();
  storageSpy.getContractors.mockReset();
  storageSpy.createDevis.mockReset();
  storageSpy.getProjects.mockResolvedValue([]);
});

describe("processDevisUpload — never auto-assigns an arbitrary contractor", () => {
  it("rejects upload with 422 when SIRET is unknown, even if other contractors exist", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      contractorName: "Brand New Co",
      siret: "99999999900099",
      amountHt: 1000,
      amountTtc: 1200,
    });
    storageSpy.getContractors.mockResolvedValue([
      { id: 1, name: "AT PISCINES", siret: "12345678900012" },
      { id: 2, name: "SAS AT TRAVAUX", siret: "82046676100021" },
    ]);

    const result = await processDevisUpload(1, {
      originalname: "devis.pdf",
      buffer: Buffer.from("%PDF-1.7 fake"),
      mimetype: "application/pdf",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect(storageSpy.createDevis).not.toHaveBeenCalled();
    const message = (result.data as { message: string }).message;
    expect(message).toContain("99999999900099");
  });

  it("rejects upload with 422 when AI extracts no contractor and fuzzy name fails", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      contractorName: "Wholly Unknown Vendor",
      amountHt: 500,
      amountTtc: 600,
    });
    storageSpy.getContractors.mockResolvedValue([
      { id: 1, name: "AT PISCINES", siret: "12345678900012" },
    ]);

    const result = await processDevisUpload(1, {
      originalname: "devis.pdf",
      buffer: Buffer.from("%PDF-1.7 fake"),
      mimetype: "application/pdf",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect(storageSpy.createDevis).not.toHaveBeenCalled();
  });

  it("happy path: SIRET match assigns the right contractor and creates the devis", async () => {
    parseDocumentMock.mockResolvedValue({
      documentType: "quotation",
      contractorName: "AT TRAVAUX",
      siret: "82046676100021",
      amountHt: 1000,
      amountTtc: 1200,
    });
    storageSpy.getContractors.mockResolvedValue([
      { id: 1, name: "AT PISCINES", siret: "12345678900012" },
      { id: 42, name: "SAS AT TRAVAUX", siret: "82046676100021" },
    ]);
    storageSpy.createDevis.mockResolvedValue({
      id: 500, projectId: 1, contractorId: 42, status: "draft",
      validationWarnings: [], aiExtractedData: {}, aiConfidence: 100,
    });

    const result = await processDevisUpload(1, {
      originalname: "devis.pdf",
      buffer: Buffer.from("%PDF-1.7 fake"),
      mimetype: "application/pdf",
    });

    expect(result.success).toBe(true);
    expect(storageSpy.createDevis).toHaveBeenCalledTimes(1);
    const createCall = storageSpy.createDevis.mock.calls[0][0] as { contractorId: number };
    expect(createCall.contractorId).toBe(42); // not 1 (AT PISCINES, the first row)
  });
});
