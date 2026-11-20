import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getDevisLineContexts: vi.fn(), getDevisLineContextAssetsByDevis: vi.fn(), getDocumentBuffer: vi.fn(),
}));
vi.mock("../../storage", () => ({ storage: mocks }));
vi.mock("../../storage/object-storage", () => ({ getDocumentBuffer: mocks.getDocumentBuffer, uploadDocument: vi.fn() }));
import { loadLineContextRenders } from "../devis-translation-generator";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDevisLineContexts.mockResolvedValue([{ devisLineItemId: 3, document: {
    type: "doc", content: [{ type: "image", attrs: { assetId: 7 } }],
  } }]);
  mocks.getDevisLineContextAssetsByDevis.mockResolvedValue([{ id: 7, devisLineItemId: 3, storageKey: "private", mimeType: "image/png" }]);
  mocks.getDocumentBuffer.mockResolvedValue(Buffer.from("image"));
});
it("web rendering never downloads or embeds the original image bytes", async () => {
  const result = await loadLineContextRenders(51, id => `/p/client/test/context-assets/${id}`);
  expect(mocks.getDocumentBuffer).not.toHaveBeenCalled();
  expect(result.get(3)?.html).toContain('src="/p/client/test/context-assets/7"');
  expect(result.get(3)?.html).not.toContain("base64");
});
it("PDF rendering keeps self-contained image data", async () => {
  const result = await loadLineContextRenders(51);
  expect(mocks.getDocumentBuffer).toHaveBeenCalledWith("private");
  expect(result.get(3)?.html).toContain("data:image/png;base64,");
});
it("does not emit cross-line image URLs", async () => {
  mocks.getDevisLineContextAssetsByDevis.mockResolvedValue([{ id: 7, devisLineItemId: 99 }]);
  const result = await loadLineContextRenders(51, id => `/p/client/test/context-assets/${id}`);
  expect(result.get(3)?.html).not.toContain("<img");
});
