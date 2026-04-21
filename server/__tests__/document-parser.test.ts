import { describe, it, expect, vi } from "vitest";
import { retry } from "../lib/retry";
import {
  isTransientGeminiError,
  isTransientParseFailure,
  getParseFailureMessage,
  parseDocument,
  type ParsedDocument,
} from "../gmail/document-parser";

describe("isTransientGeminiError", () => {
  it("matches Gemini 503 service-unavailable error", () => {
    const err = new Error(
      "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
    );
    expect(isTransientGeminiError(err)).toBe(true);
  });

  it("matches Gemini 429 rate-limit error", () => {
    const err = new Error("[GoogleGenerativeAI Error]: [429 Too Many Requests] Quota exceeded.");
    expect(isTransientGeminiError(err)).toBe(true);
  });

  it("matches 500/502/504 errors", () => {
    expect(isTransientGeminiError(new Error("[500 Internal Server Error]"))).toBe(true);
    expect(isTransientGeminiError(new Error("[502 Bad Gateway]"))).toBe(true);
    expect(isTransientGeminiError(new Error("[504 Gateway Timeout]"))).toBe(true);
  });

  it("matches network-level transient errors without HTTP status", () => {
    expect(isTransientGeminiError(new Error("fetch failed"))).toBe(true);
    expect(isTransientGeminiError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientGeminiError(new Error("Service Unavailable"))).toBe(true);
  });

  it("does not match permanent errors", () => {
    expect(isTransientGeminiError(new Error("[400 Bad Request] Invalid prompt"))).toBe(false);
    expect(isTransientGeminiError(new Error("[401 Unauthorized] API key invalid"))).toBe(false);
    expect(isTransientGeminiError(new Error("[404 Not Found]"))).toBe(false);
    expect(isTransientGeminiError(new Error("Unexpected token in JSON"))).toBe(false);
  });

  it("trusts explicit 4xx status over transient-sounding keywords", () => {
    // A 4xx error whose body coincidentally contains a transient keyword must
    // NOT be retried — the status is authoritative.
    expect(
      isTransientGeminiError(new Error("[400 Bad Request] service unavailable for this prompt")),
    ).toBe(false);
    expect(
      isTransientGeminiError(new Error("[403 Forbidden] rate limit policy violation")),
    ).toBe(false);
  });

  it("handles non-Error inputs without throwing", () => {
    expect(isTransientGeminiError(null)).toBe(false);
    expect(isTransientGeminiError(undefined)).toBe(false);
    expect(isTransientGeminiError("[503 Service Unavailable]")).toBe(true);
  });
});

describe("isTransientParseFailure / getParseFailureMessage", () => {
  it("flags transient parse failures", () => {
    const parsed = { documentType: "unknown" as const, rawText: "Parse failed (transient): [503 Service Unavailable]" };
    expect(isTransientParseFailure(parsed)).toBe(true);
    expect(getParseFailureMessage(parsed)).toBe("[503 Service Unavailable]");
  });

  it("does not flag permanent parse failures as transient", () => {
    const parsed = { documentType: "unknown" as const, rawText: "Parse failed: Unexpected token" };
    expect(isTransientParseFailure(parsed)).toBe(false);
    expect(getParseFailureMessage(parsed)).toBe("Unexpected token");
  });

  it("returns null when there's no parse failure marker", () => {
    expect(getParseFailureMessage({ documentType: "quotation", contractorName: "ACME" })).toBeNull();
    expect(getParseFailureMessage({ documentType: "unknown" as const, rawText: "PDF conversion produced no images" })).toBeNull();
  });

  it("does not flag successful extractions", () => {
    expect(isTransientParseFailure({ documentType: "quotation", amountHt: 1000 })).toBe(false);
  });
});

describe("retry config used by parseWithGemini", () => {
  // parseWithGemini wraps generateContent in retry({ retries: 2, shouldRetry: isTransientGeminiError, ... }).
  // This test validates that exact configuration: 2 transient failures then success returns the value.
  it("succeeds when transient errors occur twice then the call resolves", async () => {
    const generateContent = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("[503 Service Unavailable] Gemini"))
      .mockRejectedValueOnce(new Error("[503 Service Unavailable] Gemini"))
      .mockResolvedValueOnce("ok");

    const result = await retry(generateContent, {
      retries: 2,
      baseMs: 1,
      maxMs: 5,
      factor: 3,
      jitter: false,
      shouldRetry: isTransientGeminiError,
    });

    expect(result).toBe("ok");
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent errors (4xx)", async () => {
    const generateContent = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("[400 Bad Request] bad prompt"));

    await expect(
      retry(generateContent, {
        retries: 2,
        baseMs: 1,
        maxMs: 5,
        jitter: false,
        shouldRetry: isTransientGeminiError,
      }),
    ).rejects.toThrow(/400/);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries on persistent transient errors", async () => {
    const generateContent = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("[503 Service Unavailable] Gemini"));

    await expect(
      retry(generateContent, {
        retries: 2,
        baseMs: 1,
        maxMs: 5,
        jitter: false,
        shouldRetry: isTransientGeminiError,
      }),
    ).rejects.toThrow(/503/);
    expect(generateContent).toHaveBeenCalledTimes(3);
  });
});

describe("parseDocument retry & fallback", () => {
  const fakeImages = [Buffer.from("img1")];
  const baseDeps = {
    pdfToImages: vi.fn(async () => fakeImages),
    getActiveModel: vi.fn(async () => ({ provider: "gemini", modelId: "gemini-2.5-flash" })),
    getOpenAIFallbackModelId: vi.fn(async () => "gpt-4o"),
    hasOpenAIKey: vi.fn(() => true),
  };

  it("falls back to OpenAI when Gemini exhausts transient retries (Gemini fails 3x → OpenAI succeeds)", async () => {
    const successDoc: ParsedDocument = {
      documentType: "quotation",
      contractorName: "ACME BTP",
      amountHt: 1000,
    };
    const parseWithGemini = vi
      .fn<(images: Buffer[], modelId: string) => Promise<ParsedDocument>>()
      // simulate parseWithGemini already exhausted its 3 internal attempts and threw
      .mockRejectedValue(new Error("[503 Service Unavailable] Gemini overloaded"));
    const parseWithOpenAI = vi
      .fn<(images: Buffer[], modelId: string) => Promise<ParsedDocument>>()
      .mockResolvedValue(successDoc);

    const result = await parseDocument(Buffer.from("pdf"), "test.pdf", {
      ...baseDeps,
      parseWithGemini,
      parseWithOpenAI,
    });

    expect(parseWithGemini).toHaveBeenCalledTimes(1);
    expect(parseWithOpenAI).toHaveBeenCalledTimes(1);
    expect(parseWithOpenAI).toHaveBeenCalledWith(fakeImages, "gpt-4o");
    expect(result).toEqual(successDoc);
  });

  it("preserves the final error message when both Gemini and OpenAI fail", async () => {
    const parseWithGemini = vi
      .fn<(images: Buffer[], modelId: string) => Promise<ParsedDocument>>()
      .mockRejectedValue(new Error("[503 Service Unavailable] Gemini overloaded"));
    const parseWithOpenAI = vi
      .fn<(images: Buffer[], modelId: string) => Promise<ParsedDocument>>()
      .mockRejectedValue(new Error("[502 Bad Gateway] OpenAI"));

    const result = await parseDocument(Buffer.from("pdf"), "test.pdf", {
      ...baseDeps,
      parseWithGemini,
      parseWithOpenAI,
    });

    expect(result.documentType).toBe("unknown");
    // Final cause is the OpenAI error (502), not the Gemini one (503).
    expect(result.rawText).toBe("Parse failed (transient): [502 Bad Gateway] OpenAI");
    expect(isTransientParseFailure(result)).toBe(true);
  });

  it("does NOT retry/fallback on a permanent Gemini error and surfaces it as permanent", async () => {
    const parseWithGemini = vi
      .fn<(images: Buffer[], modelId: string) => Promise<ParsedDocument>>()
      .mockRejectedValue(new Error("[400 Bad Request] image too large"));
    const parseWithOpenAI = vi.fn();

    const result = await parseDocument(Buffer.from("pdf"), "test.pdf", {
      ...baseDeps,
      parseWithGemini,
      parseWithOpenAI,
    });

    expect(parseWithOpenAI).not.toHaveBeenCalled();
    expect(result.documentType).toBe("unknown");
    expect(result.rawText).toBe("Parse failed: [400 Bad Request] image too large");
    expect(isTransientParseFailure(result)).toBe(false);
  });

  it("re-classifies a permanent OpenAI fallback failure as permanent (not transient)", async () => {
    const parseWithGemini = vi
      .fn<(images: Buffer[], modelId: string) => Promise<ParsedDocument>>()
      .mockRejectedValue(new Error("[503 Service Unavailable] Gemini"));
    const parseWithOpenAI = vi
      .fn<(images: Buffer[], modelId: string) => Promise<ParsedDocument>>()
      .mockRejectedValue(new Error("[401 Unauthorized] Invalid OpenAI key"));

    const result = await parseDocument(Buffer.from("pdf"), "test.pdf", {
      ...baseDeps,
      parseWithGemini,
      parseWithOpenAI,
    });

    expect(result.rawText).toBe("Parse failed: [401 Unauthorized] Invalid OpenAI key");
    expect(isTransientParseFailure(result)).toBe(false);
  });

  it("skips OpenAI fallback when no OpenAI key is configured", async () => {
    const parseWithGemini = vi
      .fn<(images: Buffer[], modelId: string) => Promise<ParsedDocument>>()
      .mockRejectedValue(new Error("[503 Service Unavailable] Gemini"));
    const parseWithOpenAI = vi.fn();
    const hasOpenAIKey = vi.fn(() => false);

    const result = await parseDocument(Buffer.from("pdf"), "test.pdf", {
      ...baseDeps,
      parseWithGemini,
      parseWithOpenAI,
      hasOpenAIKey,
    });

    expect(parseWithOpenAI).not.toHaveBeenCalled();
    expect(result.rawText).toBe("Parse failed (transient): [503 Service Unavailable] Gemini");
    expect(isTransientParseFailure(result)).toBe(true);
  });
});
