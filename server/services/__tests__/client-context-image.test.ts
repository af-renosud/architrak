import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getDevisTranslation: vi.fn(),
  getDevisLineContextAssetsByDevis: vi.fn(),
  getDevisLineContexts: vi.fn(),
  getDocumentStream: vi.fn(),
}));
vi.mock("../../storage", () => ({ storage: mocks }));
vi.mock("../../storage/object-storage", () => ({ getDocumentStream: mocks.getDocumentStream }));
import { streamClientContextImage } from "../client-context-image";

describe("client context image disclosure", () => {
  const res = { sendStatus: vi.fn(), setHeader: vi.fn(), destroy: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDevisTranslation.mockResolvedValue({ status: "finalised" });
    mocks.getDevisLineContextAssetsByDevis.mockResolvedValue([{ id: 7, devisLineItemId: 3, mimeType: "image/png", storageKey: "private-key" }]);
    mocks.getDevisLineContexts.mockResolvedValue([{ devisLineItemId: 3, document: { type: "doc", content: [{ type: "image", attrs: { assetId: 7 } }] } }]);
    mocks.getDocumentStream.mockResolvedValue({ stream: { on: vi.fn(), pipe: vi.fn() } });
  });
  it("streams an owned, referenced image without public caching", async () => {
    await streamClientContextImage(51, "7", res as any);
    expect(mocks.getDocumentStream).toHaveBeenCalledWith("private-key");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
  it.each(["open", "edited"])("refuses images from %s translations", async status => {
    mocks.getDevisTranslation.mockResolvedValue({ status });
    await streamClientContextImage(51, "7", res as any);
    expect(res.sendStatus).toHaveBeenCalledWith(404);
    expect(mocks.getDocumentStream).not.toHaveBeenCalled();
  });
  it("refuses images outside the quotation", async () => {
    mocks.getDevisLineContextAssetsByDevis.mockResolvedValue([]);
    await streamClientContextImage(51, "7", res as any);
    expect(mocks.getDocumentStream).not.toHaveBeenCalled();
  });
  it("refuses a cross-line image reference", async () => {
    mocks.getDevisLineContexts.mockResolvedValue([{ devisLineItemId: 99, document: { type: "doc", content: [{ type: "image", attrs: { assetId: 7 } }] } }]);
    await streamClientContextImage(51, "7", res as any);
    expect(mocks.getDocumentStream).not.toHaveBeenCalled();
  });
  it("refuses removed context images", async () => {
    mocks.getDevisLineContexts.mockResolvedValue([]);
    await streamClientContextImage(51, "7", res as any);
    expect(mocks.getDocumentStream).not.toHaveBeenCalled();
  });
});
