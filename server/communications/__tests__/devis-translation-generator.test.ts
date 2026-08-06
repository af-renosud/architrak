import { describe, it, expect, vi, beforeEach } from "vitest";
import { PDFDocument, PageSizes } from "pdf-lib";

vi.mock("../../env", () => ({
  env: {
    DEFAULT_OBJECT_STORAGE_BUCKET_ID: "test-bucket",
    PRIVATE_OBJECT_DIR: "/test-bucket/.private",
    DOCRAPTOR_API_KEY: "test-docraptor-key",
  },
}));

vi.mock("../../storage", () => ({
  storage: {
    getDevis: vi.fn(),
    getDevisTranslation: vi.fn(),
    getProject: vi.fn(),
    getContractor: vi.fn(),
    getDevisLineItems: vi.fn(),
    getTemplateAssetByType: vi.fn(),
    updateDevisTranslation: vi.fn(),
    updateDevisTranslationIfContextsVersion: vi.fn(),
    getDevisLineContexts: vi.fn(),
    getDevisLineContextAssets: vi.fn(),
  },
}));

vi.mock("../../storage/object-storage", () => ({
  uploadDocument: vi.fn(),
  getDocumentBuffer: vi.fn(),
}));

vi.mock("../../services/docraptor", () => ({
  convertHtmlToPdf: vi.fn(),
}));

import { storage } from "../../storage";
import { getDocumentBuffer, uploadDocument } from "../../storage/object-storage";
import { generateCombinedPdf, getValidatedCachedPdfKey } from "../devis-translation-generator";

const getDevis = storage.getDevis as unknown as ReturnType<typeof vi.fn>;
const getDevisTranslation = storage.getDevisTranslation as unknown as ReturnType<typeof vi.fn>;
const updateDevisTranslation = storage.updateDevisTranslation as unknown as ReturnType<typeof vi.fn>;
const updateIfVersion = storage.updateDevisTranslationIfContextsVersion as unknown as ReturnType<typeof vi.fn>;
const getDocumentBufferMock = getDocumentBuffer as unknown as ReturnType<typeof vi.fn>;
const uploadDocumentMock = uploadDocument as unknown as ReturnType<typeof vi.fn>;

// Build a PDF with N pages of a specific size (width, height) so we can later
// inspect the merged document and prove which pages came from which source.
async function buildPdf(pages: Array<[number, number]>): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const [w, h] of pages) {
    doc.addPage([w, h]);
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

describe("generateCombinedPdf — page ordering", () => {
  const getDevisLineContexts = storage.getDevisLineContexts as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    updateDevisTranslation.mockResolvedValue({});
    updateIfVersion.mockResolvedValue(true);
    uploadDocumentMock.mockResolvedValue("storage/key/combined.pdf");
    getDevisLineContexts.mockResolvedValue([]);
  });

  it("merges translated pages first, then original, preserving page counts and source order", async () => {
    getDevis.mockResolvedValue({
      id: 7,
      devisCode: "D-7",
      pdfStorageKey: "storage/key/original.pdf",
      projectId: 1,
    });
    getDevisTranslation.mockResolvedValue({
      status: "draft",
      translatedPdfStorageKey: "storage/key/translated.pdf",
      headerTranslated: {},
      lineTranslations: [],
    });

    // Original = 3 portrait A4 pages (595 x 842)
    const [aw, ah] = PageSizes.A4;
    const originalPdf = await buildPdf([
      [aw, ah],
      [aw, ah],
      [aw, ah],
    ]);
    // Translated = 2 landscape A4 pages (842 x 595) — distinguishable by size
    const translatedPdf = await buildPdf([
      [ah, aw],
      [ah, aw],
    ]);

    getDocumentBufferMock.mockImplementation(async (key: string) => {
      if (key === "storage/key/original.pdf") return originalPdf;
      if (key === "storage/key/translated.pdf") return translatedPdf;
      throw new Error(`Unexpected key: ${key}`);
    });

    const { storageKey, pdfBuffer } = await generateCombinedPdf(7);

    expect(storageKey).toBe("storage/key/combined.pdf");
    expect(pdfBuffer.length).toBeGreaterThan(0);

    const merged = await PDFDocument.load(pdfBuffer);
    expect(merged.getPageCount()).toBe(5);

    const sizes = merged.getPages().map((p) => {
      const { width, height } = p.getSize();
      return [Math.round(width), Math.round(height)] as const;
    });

    // First two pages must be landscape (from the English translation PDF)
    expect(sizes[0]).toEqual([Math.round(ah), Math.round(aw)]);
    expect(sizes[1]).toEqual([Math.round(ah), Math.round(aw)]);
    // Then three portrait pages (from the original French PDF)
    expect(sizes[2]).toEqual([Math.round(aw), Math.round(ah)]);
    expect(sizes[3]).toEqual([Math.round(aw), Math.round(ah)]);
    expect(sizes[4]).toEqual([Math.round(aw), Math.round(ah)]);

    // Combined PDF storage key is published via the version-guarded update,
    // conditional on the contexts_version read with the translation row.
    expect(updateIfVersion).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ combinedPdfStorageKey: "storage/key/combined.pdf" }),
      0,
    );
    expect(updateDevisTranslation).not.toHaveBeenCalled();
  });

  it("does NOT cache the combined PDF when a context save lands during generation (version-guarded publish no-ops)", async () => {
    getDevis.mockResolvedValue({
      id: 7,
      devisCode: "D-7",
      pdfStorageKey: "storage/key/original.pdf",
      projectId: 1,
    });
    getDevisTranslation.mockResolvedValue({
      status: "draft",
      translatedPdfStorageKey: "storage/key/translated.pdf",
      contextsVersion: 4,
      headerTranslated: {},
      lineTranslations: [],
    });
    const [aw, ah] = PageSizes.A4;
    const originalPdf = await buildPdf([[aw, ah]]);
    const translatedPdf = await buildPdf([[ah, aw]]);
    getDocumentBufferMock.mockImplementation(async (key: string) =>
      key === "storage/key/original.pdf" ? originalPdf : translatedPdf,
    );

    // Deterministic race: the concurrent context save bumped
    // contexts_version (atomically clearing the cache keys), so the
    // conditional UPDATE matches no row — the DB itself refuses the publish.
    updateIfVersion.mockResolvedValue(false);

    const { storageKey, pdfBuffer } = await generateCombinedPdf(7);
    expect(storageKey).toBe("storage/key/combined.pdf");
    expect(pdfBuffer.length).toBeGreaterThan(0);
    // Publish attempted with the version captured at the row read...
    expect(updateIfVersion).toHaveBeenCalledWith(7, expect.anything(), 4);
    // ...and no unconditional write bypasses the guard.
    expect(updateDevisTranslation).not.toHaveBeenCalled();
  });

  it("guards the publish with the contexts_version captured at the translation-row read", async () => {
    getDevis.mockResolvedValue({
      id: 7,
      devisCode: "D-7",
      pdfStorageKey: "storage/key/original.pdf",
      projectId: 1,
    });
    getDevisTranslation.mockResolvedValue({
      status: "draft",
      translatedPdfStorageKey: "storage/key/translated.pdf",
      contextsVersion: 9,
      headerTranslated: {},
      lineTranslations: [],
    });
    const [aw, ah] = PageSizes.A4;
    const originalPdf = await buildPdf([[aw, ah]]);
    const translatedPdf = await buildPdf([[ah, aw]]);
    getDocumentBufferMock.mockImplementation(async (key: string) =>
      key === "storage/key/original.pdf" ? originalPdf : translatedPdf,
    );

    await generateCombinedPdf(7);

    // The cached translated key and the guard version come from the SAME
    // atomic row read, so the reused buffer and the guard can never diverge.
    expect(updateIfVersion).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ combinedPdfStorageKey: "storage/key/combined.pdf" }),
      9,
    );
  });

  it("throws when the devis has no original PDF attached", async () => {
    getDevis.mockResolvedValue({ id: 9, devisCode: "D-9", pdfStorageKey: null, projectId: 1 });
    await expect(generateCombinedPdf(9)).rejects.toThrow(/has no original PDF/);
  });

  it("throws when there is no translation row", async () => {
    getDevis.mockResolvedValue({ id: 11, devisCode: "D-11", pdfStorageKey: "k", projectId: 1 });
    getDevisTranslation.mockResolvedValue(null);
    await expect(generateCombinedPdf(11)).rejects.toThrow(/No translation/);
  });
});

describe("getValidatedCachedPdfKey — cached key reads (keys are never stale in the row)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["translated", { translatedPdfStorageKey: "k-translated", combinedPdfStorageKey: null }, "k-translated"],
    ["combined", { translatedPdfStorageKey: null, combinedPdfStorageKey: "k-combined" }, "k-combined"],
  ] as const)("returns the cached %s key from the row", async (kind, row, expected) => {
    getDevisTranslation.mockResolvedValue(row);
    await expect(getValidatedCachedPdfKey(7, kind)).resolves.toBe(expected);
  });

  it("returns null when no cached key exists (concurrent save cleared it atomically)", async () => {
    getDevisTranslation.mockResolvedValue({ translatedPdfStorageKey: null, combinedPdfStorageKey: null });
    await expect(getValidatedCachedPdfKey(7, "translated")).resolves.toBeNull();
    await expect(getValidatedCachedPdfKey(7, "combined")).resolves.toBeNull();
  });

  it("returns null when there is no translation row", async () => {
    getDevisTranslation.mockResolvedValue(null);
    await expect(getValidatedCachedPdfKey(7, "translated")).resolves.toBeNull();
  });
});
