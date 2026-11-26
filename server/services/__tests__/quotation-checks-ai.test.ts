import { describe, expect, it } from "vitest";
import { aiFailure, parseAiPoints } from "../quotation-checks";
import { GeminiTimeoutError } from "../gemini";

const loaded = {
  quotation: { id: 1 }, archived: false, lotFallback: "General", fingerprint: "x",
  lines: [
    { id: 11, lineNumber: 1, description: "LOT COUVERTURE Velux ?", quantity: "2", unit: "U", unitPriceHt: "800", totalHt: "1600", vatRate: null },
    { id: 12, lineNumber: 2, description: "Zinc ☑", quantity: "10", unit: "ml", unitPriceHt: "50", totalHt: "500", vatRate: null },
  ],
};

describe("AI suggestion parsing", () => {
  it("keeps valid suggestions, maps line numbers and drops ones about unknown lines", () => {
    const text = "```json\n" + JSON.stringify({ points: [
      { category: "annotation", lineNumbers: [1], finding: "A question mark follows the Velux line.", suggestedAction: "Ask what is uncertain." },
      { category: "overlap", lineNumbers: [99], finding: "Refers to a line that does not exist.", suggestedAction: "Nothing to do here." },
    ] }) + "\n```";
    const pts = parseAiPoints(text, loaded, 7);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ key: "ai:7:0", source: "ai", category: "ai_annotation", lines: [{ id: 11, lineNumber: 1, lot: "COUVERTURE" }] });
  });

  it("rejects unreadable answers and never echoes provider messages", () => {
    expect(() => parseAiPoints("Sorry, I cannot help", loaded, 1)).toThrow();
    expect(() => parseAiPoints(JSON.stringify({ points: [{ category: "price", lineNumbers: [1], finding: "Too expensive", suggestedAction: "Negotiate" }] }), loaded, 1)).toThrow();
    expect(aiFailure(new GeminiTimeoutError())).toMatch(/did not answer in time/);
    expect(aiFailure(new SyntaxError("x"))).toMatch(/could not be read/);
    expect(aiFailure(new Error("Gemini API error 402: {\"message\":\"credits depleted\"}"))).toMatch(/run out of credit/);
    expect(aiFailure(new Error("Gemini API error 403: key AIza... invalid"))).toBe("The AI service could not be reached. Try again shortly.");
  });
});
