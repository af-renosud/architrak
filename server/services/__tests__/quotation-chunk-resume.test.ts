import { describe, expect, it, vi } from "vitest";
import { parseDocument, type ParsedDocument } from "../../gmail/document-parser";

describe("source-bound chunk resumption", () => {
  it("retains completed groups after failure and invalidates them for changed source or model", async () => {
    const saved = new Map<string, ParsedDocument>();
    let fail = true;
    const provider = vi.fn(async (images: Buffer[]) => {
      if (images[0].toString() === "5" && fail) throw new Error("provider failed");
      return { documentType: "quotation" as const, amountHt: 60, amountTtc: 72,
        lineItems: images.map(image => ({ description: `Item ${image}`, quantity: 1, unitPrice: 10, total: 10, pageHint: Number(image.toString()) % 5 + 1 })) };
    });
    const deps = {
      pdfToImagesWithCoverage: async () => ({ images: Array.from({ length: 6 }, (_, i) => Buffer.from(String(i))), pdfPageCount: 6 }),
      getPageTexts: async () => Array(6).fill(null),
      getActiveModel: async () => ({ provider: "openai", modelId: "fixture" }),
      parseWithOpenAI: provider,
      hasGeminiKey: () => false,
      getOpenAIFallbackModelId: async () => "fallback",
      getDenseCompletenessFallbackModelId: async () => null,
      checkpoint: {
        load: async (key: string) => saved.get(key) ?? null,
        save: async (key: string, result: ParsedDocument) => { saved.set(key, structuredClone(result)); },
      },
    };
    expect((await parseDocument(Buffer.from("source"), "fixture.pdf", deps)).documentType).toBe("unknown");
    expect(saved.size).toBe(1);
    fail = false;
    provider.mockClear();
    expect((await parseDocument(Buffer.from("source"), "fixture.pdf", deps)).lineItems).toHaveLength(6);
    expect(provider).toHaveBeenCalledTimes(1);
    provider.mockClear();
    await parseDocument(Buffer.from("other source"), "fixture.pdf", deps);
    expect(provider).toHaveBeenCalledTimes(2);
    provider.mockClear();
    await parseDocument(Buffer.from("source"), "fixture.pdf", { ...deps,
      getActiveModel: async () => ({ provider: "openai", modelId: "changed" }) });
    expect(provider).toHaveBeenCalledTimes(2);
  });
});
