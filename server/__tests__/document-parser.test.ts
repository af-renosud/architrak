import { describe, it, expect } from "vitest";
import {
  isTransientGeminiError,
  isTransientParseFailure,
  getParseFailureMessage,
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
