import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../storage", () => ({
  storage: {
    getDevisLineItems: vi.fn(),
    getDevis: vi.fn(),
    getDevisTranslation: vi.fn(),
    updateDevisTranslation: vi.fn(),
    bumpContextsVersionAndClearPdfCache: vi.fn(),
    getDevisLineContext: vi.fn(),
    getDevisLineContexts: vi.fn(),
    createDevisLineContext: vi.fn(),
    updateDevisLineContextIfRevision: vi.fn(),
    saveDevisLineContextGuarded: vi.fn(),
    createDevisLineContextAsset: vi.fn(),
    getDevisLineContextAsset: vi.fn(),
    getDevisLineContextAssets: vi.fn(),
    getDevisLineContextAssetsByDevis: vi.fn(),
  },
}));

vi.mock("../../storage/object-storage", () => ({
  uploadDocument: vi.fn(),
}));

import { storage } from "../../storage";
import { uploadDocument } from "../../storage/object-storage";
import {
  saveLineContext,
  uploadLineContextAsset,
  getOwnedContextAsset,
  LineContextError,
} from "../devis-line-context";

const s = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
const uploadDocumentMock = uploadDocument as unknown as ReturnType<typeof vi.fn>;

const LINE = { id: 42, devisId: 7, lineNumber: 3, description: "Cloison placo" };

const textDoc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

beforeEach(() => {
  vi.clearAllMocks();
  s.getDevisLineItems.mockResolvedValue([LINE]);
  s.getDevisTranslation.mockResolvedValue(null);
});

describe("saveLineContext", () => {
  it("creates a new context row at revision 1 when baseRevision is 0", async () => {
    s.saveDevisLineContextGuarded.mockResolvedValue({
      outcome: "saved",
      row: { id: 1, devisId: 7, devisLineItemId: 42, revision: 1 },
    });

    const saved = await saveLineContext({
      devisId: 7,
      devisLineItemId: 42,
      document: textDoc("hello"),
      baseRevision: 0,
    });
    expect(saved.revision).toBe(1);
    expect(s.saveDevisLineContextGuarded).toHaveBeenCalledWith(7, 42, expect.anything(), 0);
  });

  it("rejects any context save once the translation is finalised (approval artifact must not change)", async () => {
    s.getDevisTranslation.mockResolvedValue({ devisId: 7, status: "finalised" });
    await expect(
      saveLineContext({ devisId: 7, devisLineItemId: 42, document: textDoc("late edit"), baseRevision: 5 }),
    ).rejects.toMatchObject({ status: 409 });
    // Fast-path rejection: the guarded write is never attempted.
    expect(s.saveDevisLineContextGuarded).not.toHaveBeenCalled();
    expect(s.updateDevisTranslation).not.toHaveBeenCalled(); // cached signer PDFs untouched
  });

  it("rejects a save that races a concurrent finalise: the DB-level guard fires even after the fast-path check passed", async () => {
    // Interleaving: status is NOT finalised when the pre-check runs...
    s.getDevisTranslation.mockResolvedValue({ devisId: 7, status: "edited" });
    // ...but the finalise commits first inside the guarded transaction
    // (FOR UPDATE on the translation row orders the two), so the guarded
    // save reports "finalised" and nothing was committed.
    s.saveDevisLineContextGuarded.mockResolvedValue({ outcome: "finalised" });

    await expect(
      saveLineContext({ devisId: 7, devisLineItemId: 42, document: textDoc("late edit"), baseRevision: 5 }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("finalised") });
  });

  it("maps a lost concurrent first-create race to 409, not 500", async () => {
    // ON CONFLICT DO NOTHING — another writer won the unique slot
    s.saveDevisLineContextGuarded.mockResolvedValue({ outcome: "stale_create" });
    await expect(
      saveLineContext({ devisId: 7, devisLineItemId: 42, document: textDoc("x"), baseRevision: 0 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a stale save with 409 when the revision does not match", async () => {
    s.saveDevisLineContextGuarded.mockResolvedValue({ outcome: "stale_update" });

    await expect(
      saveLineContext({ devisId: 7, devisLineItemId: 42, document: textDoc("x"), baseRevision: 4 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a document referencing an asset not uploaded for this line", async () => {
    s.getDevisLineContextAssets.mockResolvedValue([{ id: 900 }]);
    await expect(
      saveLineContext({
        devisId: 7,
        devisLineItemId: 42,
        document: { type: "doc", content: [{ type: "image", attrs: { assetId: 999 } }] },
        baseRevision: 0,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects invalid documents (unsafe link) with 400", async () => {
    await expect(
      saveLineContext({
        devisId: 7,
        devisLineItemId: 42,
        document: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
          ],
        },
        baseRevision: 0,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("404s when the line item does not belong to the devis", async () => {
    await expect(
      saveLineContext({ devisId: 7, devisLineItemId: 777, document: textDoc("x"), baseRevision: 0 }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("performs the entire save through the single guarded transaction (write + version bump + cache clear commit together)", async () => {
    s.getDevisTranslation.mockResolvedValue({
      devisId: 7,
      status: "edited",
      translatedPdfStorageKey: "k1",
      combinedPdfStorageKey: "k2",
    });
    s.saveDevisLineContextGuarded.mockResolvedValue({
      outcome: "saved",
      row: { id: 1, devisId: 7, devisLineItemId: 42, revision: 3 },
    });

    const saved = await saveLineContext({ devisId: 7, devisLineItemId: 42, document: textDoc("x"), baseRevision: 2 });
    expect(saved.revision).toBe(3);
    expect(s.saveDevisLineContextGuarded).toHaveBeenCalledWith(7, 42, expect.anything(), 2);
    // No separate (non-atomic) writes outside the guarded transaction.
    expect(s.updateDevisTranslation).not.toHaveBeenCalled();
    expect(s.createDevisLineContext).not.toHaveBeenCalled();
    expect(s.updateDevisLineContextIfRevision).not.toHaveBeenCalled();
  });

  it("survives force re-translation by design: context storage is fully separate from lineTranslations", async () => {
    // A force retranslate rewrites devis_translations.line_translations; the
    // context tables are keyed by devis_line_items.id and are never touched
    // by any translation write. This test pins the contract: saving context
    // performs NO write to lineTranslations.
    s.saveDevisLineContextGuarded.mockResolvedValue({
      outcome: "saved",
      row: { id: 1, devisId: 7, devisLineItemId: 42, revision: 1 },
    });
    s.getDevisTranslation.mockResolvedValue({ devisId: 7, translatedPdfStorageKey: "k", combinedPdfStorageKey: null });

    await saveLineContext({ devisId: 7, devisLineItemId: 42, document: textDoc("kept"), baseRevision: 0 });

    for (const call of s.updateDevisTranslation.mock.calls) {
      expect(Object.keys(call[1])).not.toContain("lineTranslations");
    }
  });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(64)]);
const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);

describe("uploadLineContextAsset", () => {
  beforeEach(() => {
    s.getDevisLineContextAssets.mockResolvedValue([]);
    s.getDevis.mockResolvedValue({ id: 7, projectId: 3 });
    uploadDocumentMock.mockResolvedValue("/bucket/key.png");
    s.createDevisLineContextAsset.mockImplementation(async (data: object) => ({ id: 55, ...data }));
  });

  it("rejects image uploads once the translation is finalised", async () => {
    s.getDevisTranslation.mockResolvedValue({ devisId: 7, status: "finalised" });
    await expect(uploadLineContextAsset(7, 42, PNG)).rejects.toMatchObject({ status: 409 });
    expect(uploadDocumentMock).not.toHaveBeenCalled();
  });

  it("rejects an upload racing a concurrent finalise: the guarded insert returns undefined and no asset is committed", async () => {
    // Pre-check passes (not finalised yet)...
    s.getDevisTranslation.mockResolvedValue({ devisId: 7, status: "edited" });
    // ...but by the time the guarded insert transaction takes the row lock,
    // the finalise has committed — storage refuses the row.
    s.createDevisLineContextAsset.mockResolvedValue(undefined);
    await expect(uploadLineContextAsset(7, 42, PNG)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("finalised"),
    });
  });

  it("accepts PNG, JPEG and WebP by magic bytes", async () => {
    for (const [buf, mime] of [
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [WEBP, "image/webp"],
    ] as const) {
      const asset = await uploadLineContextAsset(7, 42, buf);
      expect(asset.mimeType).toBe(mime);
    }
  });

  it("rejects SVG and other non-raster bytes regardless of any claimed content type", async () => {
    await expect(uploadLineContextAsset(7, 42, SVG)).rejects.toMatchObject({ status: 400 });
    await expect(uploadLineContextAsset(7, 42, Buffer.from("GIF89a....."))).rejects.toMatchObject({ status: 400 });
    expect(uploadDocumentMock).not.toHaveBeenCalled();
  });

  it("rejects oversized uploads with 413", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    await expect(uploadLineContextAsset(7, 42, big)).rejects.toMatchObject({ status: 413 });
  });

  it("enforces the per-line image count cap", async () => {
    s.getDevisLineContextAssets.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })));
    await expect(uploadLineContextAsset(7, 42, PNG)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects uploads for a line on a different devis", async () => {
    await expect(uploadLineContextAsset(7, 999, PNG)).rejects.toMatchObject({ status: 404 });
  });
});

describe("getOwnedContextAsset", () => {
  it("404s when the asset belongs to another devis", async () => {
    s.getDevisLineContextAsset.mockResolvedValue({ id: 5, devisId: 8, storageKey: "k" });
    await expect(getOwnedContextAsset(7, 5)).rejects.toBeInstanceOf(LineContextError);
  });

  it("returns the asset when ownership matches", async () => {
    s.getDevisLineContextAsset.mockResolvedValue({ id: 5, devisId: 7, storageKey: "k" });
    await expect(getOwnedContextAsset(7, 5)).resolves.toMatchObject({ id: 5 });
  });
});
