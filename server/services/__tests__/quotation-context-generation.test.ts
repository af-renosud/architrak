import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getDevis: vi.fn(), getProject: vi.fn(), getDevisTranslation: vi.fn(),
  getDevisLineItems: vi.fn(), getDevisLineContexts: vi.fn(), getDevisLineContextAssets: vi.fn(),
  saveDevisLineContextGuarded: vi.fn(), research: vi.fn(),
}));
vi.mock("../../storage", () => ({ storage: mocks }));
vi.mock("../../storage/object-storage", () => ({ uploadDocument: vi.fn(), deleteDocument: vi.fn() }));
vi.mock("../quotation-context-research", () => ({ researchQuotationContext: mocks.research, ContextResearchError: class extends Error {} }));
import { generateEmptyLineContext, startContextGeneration, contextGenerationStatus } from "../quotation-context-generation";
const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Helpful context" }] }] };
describe("grounded context generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDevis.mockResolvedValue({ id: 1, projectId: 2, status: "received" });
    mocks.getProject.mockResolvedValue({ id: 2, archivedAt: null });
    mocks.getDevisTranslation.mockResolvedValue({ status: "draft", lineTranslations: [{ lineNumber: 1, translation: "Heat pump" }] });
    mocks.getDevisLineItems.mockResolvedValue([{ id: 3, lineNumber: 1, description: "Pompe à chaleur" }]);
    mocks.getDevisLineContexts.mockResolvedValue([]);
    mocks.getDevisLineContextAssets.mockResolvedValue([]);
    mocks.research.mockResolvedValue({ document: doc, sources: [], warning: null });
    mocks.saveDevisLineContextGuarded.mockResolvedValue({ outcome: "saved", row: { revision: 1, document: doc } });
  });
  it("fills an existing scraped quotation through guarded context save", async () => {
    const result = await generateEmptyLineContext(1, 3);
    expect(result.context.revision).toBe(1);
    expect(mocks.research).toHaveBeenCalledWith("Pompe à chaleur", "Heat pump");
    expect(mocks.saveDevisLineContextGuarded).toHaveBeenCalledWith(1, 3, doc, 0, "Pompe à chaleur");
  });
  it("never overwrites existing context", async () => {
    mocks.getDevisLineContexts.mockResolvedValue([{ devisLineItemId: 3, document: doc, revision: 2 }]);
    await expect(generateEmptyLineContext(1, 3)).rejects.toThrow("Existing context");
    expect(mocks.research).not.toHaveBeenCalled();
  });
  it("preserves uploaded images even before their document save", async () => {
    mocks.getDevisLineContextAssets.mockResolvedValue([{ id: 7 }]);
    await expect(generateEmptyLineContext(1, 3)).rejects.toThrow("uploaded images");
    expect(mocks.research).not.toHaveBeenCalled();
  });
  it("refuses approved translations", async () => {
    mocks.getDevisTranslation.mockResolvedValue({ status: "finalised" });
    await expect(generateEmptyLineContext(1, 3)).rejects.toThrow("reopen");
    expect(mocks.research).not.toHaveBeenCalled();
  });
  it("refuses archived projects", async () => {
    mocks.getProject.mockResolvedValue({ archivedAt: new Date() });
    await expect(generateEmptyLineContext(1, 3)).rejects.toThrow("Archived");
  });
  it("rejects changed source wording after research", async () => {
    mocks.getDevisLineItems.mockResolvedValueOnce([{ id: 3, description: "Pompe", lineNumber: 1 }]);
    await expect(generateEmptyLineContext(1, 3)).rejects.toThrow("wording changed");
    expect(mocks.saveDevisLineContextGuarded).not.toHaveBeenCalled();
  });
  it("preserves a concurrent user save", async () => {
    mocks.saveDevisLineContextGuarded.mockResolvedValue({ outcome: "stale_create" });
    await expect(generateEmptyLineContext(1, 3)).rejects.toThrow("concurrently");
  });
  it("does not save when research fails", async () => {
    mocks.research.mockRejectedValue(new Error("upstream"));
    await expect(generateEmptyLineContext(1, 3)).rejects.toThrow("upstream");
    expect(mocks.saveDevisLineContextGuarded).not.toHaveBeenCalled();
  });
  it("bulk skips populated fields and exposes completion", async () => {
    mocks.getDevisLineContexts.mockResolvedValue([{ devisLineItemId: 3, document: doc }]);
    await startContextGeneration(99);
    await vi.waitFor(() => expect(contextGenerationStatus(99).running).toBe(false));
    expect(contextGenerationStatus(99).skipped).toBe(1);
    expect(mocks.research).not.toHaveBeenCalled();
  });
});
