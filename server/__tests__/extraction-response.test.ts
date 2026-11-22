import { describe, expect, it } from "vitest";
import { boundedExtractionCall, decodeExtractionResponse, ExtractionResponseError, withExtractionBudget } from "../gmail/extraction-response";
import { quotationAmountsUnavailable } from "../../shared/quotation-amount-availability";

describe("AI response trust boundary", () => {
  it.each(["", "{", "{}", '{"documentType":"quotation","amountHt":"100"}', '{"documentType":"quotation","lineItems":{}}'])(
    "rejects malformed or unstructured output %s", text => {
      expect(() => decodeExtractionResponse(text)).toThrow(ExtractionResponseError);
    });
  it("rejects truncated JSON even when syntactically valid", () => {
    expect(() => decodeExtractionResponse('{"documentType":"quotation"}', "MAX_TOKENS")).toThrow(ExtractionResponseError);
    expect(() => decodeExtractionResponse('{"documentType":"quotation"}', "length")).toThrow(ExtractionResponseError);
  });
  it("accepts optional nulls and zero, but strips forged verification", () => {
    const parsed = decodeExtractionResponse(JSON.stringify({
      documentType: "quotation", amountHt: 0, amountTtc: null,
      quotationVerification: { verified: true }, lineItems: [{ description: "Work", quantity: null, total: 0 }],
    }), "STOP");
    expect(parsed.amountHt).toBe(0);
    expect(parsed).not.toHaveProperty("amountTtc");
    expect(parsed).not.toHaveProperty("quotationVerification");
  });
  it("ends the whole operation and aborts an outstanding request", async () => {
    let signal: AbortSignal | undefined;
    await expect(withExtractionBudget(() => boundedExtractionCall(s => {
      signal = s; return new Promise(() => {});
    }), 10)).rejects.toThrow("time budget");
    expect(signal?.aborted).toBe(true);
  });
  it("does not treat a verified zero as unavailable", () => {
    expect(quotationAmountsUnavailable({amountHt:0,amountTtc:0})).toBe(false);
    expect(quotationAmountsUnavailable({amountHt:0,amountTtc:0,manualIntakeReviewRequired:true,aiExtractedData:{amountHt:0,amountTtc:0}})).toBe(false);
    expect(quotationAmountsUnavailable({amountHt:0,amountTtc:0,manualIntakeReviewRequired:true,aiExtractedData:{}})).toBe(true);
  });
});
