import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../env", () => ({ env: { GEMINI_API_KEY: "test-only" } }));
import { researchDocument, researchQuotationContext } from "../quotation-context-research";
afterEach(() => vi.unstubAllGlobals());
describe("Gemini grounded context", () => {
  it("produces structured paragraphs, bullets and safe citations, never HTML", () => {
    const doc = researchDocument("A heat pump.\n- Feature one\n- Feature two", [{ title: "Manufacturer", uri: "https://example.com/product" }]);
    expect(doc.content.map(n => n.type)).toEqual(["paragraph", "bulletList", "paragraph"]);
    expect(() => researchDocument("Text", [{ title: "Unsafe", uri: "javascript:alert(1)" }])).toThrow();
  });
  it("enables Google Search and uses provider citations", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Product explanation." }] },
        groundingMetadata: { groundingChunks: [{ web: { title: "Manufacturer", uri: "https://example.com" } }, { web: { title: "Unsafe", uri: "http://example.com" } }] } }],
    }) });
    vi.stubGlobal("fetch", fetcher);
    const result = await researchQuotationContext("Produit", "Product");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).tools).toEqual([{ google_search: {} }]);
    const prompt = JSON.parse(fetcher.mock.calls[0][1].body).systemInstruction.parts[0].text;
    expect(prompt).toContain("British English (en-GB)");
    expect(prompt).toContain("-ise/-isation");
    expect(prompt).toContain("specialised");
    expect(prompt).toContain("Preserve exact manufacturer names");
    expect(result.sources).toEqual([{ title: "Manufacturer", uri: "https://example.com" }]);
    expect(result.warning).toBeNull();
  });
  it("does not pretend an ungrounded answer was verified", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "General explanation." }] } }],
    }) }));
    const result = await researchQuotationContext("Travaux", "Works");
    expect(result.warning).toContain("No web sources");
    expect(JSON.stringify(result.document)).toContain("not verified product");
  });
  it("fails explicitly without disclosing upstream error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "sensitive upstream details" }));
    await expect(researchQuotationContext("x", "x")).rejects.toThrow("429");
  });
});
