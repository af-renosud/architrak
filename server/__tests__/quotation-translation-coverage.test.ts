import { describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(), quotation: vi.fn(), source: vi.fn(), translation: vi.fn(), generate: vi.fn(),
}));
vi.mock("../db", () => ({ pool: { query: mocks.query } }));
vi.mock("../storage", () => ({ storage: { getDevis: mocks.quotation, getDevisLineItems: mocks.source, getDevisTranslation: mocks.translation } }));
vi.mock("../env", () => ({ env: { GEMINI_API_KEY: "mock-only-not-a-credential" } }));
vi.mock("@google/generative-ai", () => ({ GoogleGenerativeAI: class {
  getGenerativeModel() { return { generateContent: mocks.generate }; }
} }));
import { translationCriticalIssues, verifyTranslationCoverage, translationCoverageBlocker } from "../services/quotation-translation-coverage";
describe("separate translated critical evidence", () => {
  const source = [{ lineNumber: 18, description: "MEXT 205, vitrage 16 mm, 600 x 700 mm, hors peinture." }];
  const target = [{ lineNumber: 18, originalDescription: source[0].description,
    translation: "MEXT 205, 16 mm glazing, 600 x 700 mm, painting excluded." }];
  it("allows English, not literal French equality", () => expect(translationCriticalIssues(source, target)).toEqual([]));
  it("rejects missing terminal items", () => expect(translationCriticalIssues(source, []).length).toBeGreaterThan(0));
  it("rejects changed numbers", () => expect(translationCriticalIssues(source,
    [{ ...target[0], translation: target[0].translation.replace("600", "800") }]).length).toBeGreaterThan(0));
  it("rejects stale source snapshots", () => expect(translationCriticalIssues(source,
    [{ ...target[0], originalDescription: "Earlier abbreviated source" }]).length).toBeGreaterThan(0));

  it("binds a successful semantic check to the French and English header as well as lines", async () => {
    const frenchHeader = "Menuiseries hors peinture.";
    const header = { description: "Joinery, painting excluded.", summary: "Aluminium joinery." };
    mocks.quotation.mockResolvedValue({ descriptionFr: frenchHeader, aiExtractedData: { quotationVerification: { verified: true } } });
    mocks.source.mockResolvedValue(source);
    mocks.translation.mockResolvedValue({ lineTranslations: target, headerTranslated: header });
    mocks.generate.mockImplementation(async (prompt: string) => ({ response: { text: () => JSON.stringify(
      prompt.startsWith("Verify the English quotation header")
        ? { complete: true, uncertain: false, conflicts: [] }
        : { lines: [{ lineNumber: 18, complete: true, uncertain: false, missing: [] }] },
    ) } }));
    let receipt = "";
    mocks.query.mockImplementation(async (sql: string, args: any[]) => {
      if (sql.includes("INSERT")) { receipt = JSON.parse(args[1]).fingerprint; return { rows: [] }; }
      return { rows: args[1] === receipt ? [{ verified: 1 }] : [] };
    });
    await verifyTranslationCoverage(1, target, header);
    expect(await translationCoverageBlocker(1)).toBeNull();
    mocks.translation.mockResolvedValue({ lineTranslations: target,
      headerTranslated: { ...header, description: "Joinery, painting included." } });
    expect(await translationCoverageBlocker(1)).toContain("not been verified");
    mocks.translation.mockResolvedValue({ lineTranslations: target,
      headerTranslated: { ...header, summary: "999 windows including painting." } });
    expect(await translationCoverageBlocker(1)).toContain("unsupported numbers");
    mocks.translation.mockResolvedValue({ lineTranslations: target, headerTranslated: header });
    mocks.quotation.mockResolvedValue({ descriptionFr: "Menuiseries avec peinture.",
      aiExtractedData: { quotationVerification: { verified: true } } });
    expect(await translationCoverageBlocker(1)).toContain("not been verified");
  });
  it("does not issue a receipt when semantic header verification fails", async () => {
    mocks.query.mockClear();
    mocks.generate.mockResolvedValue({ response: { text: () => JSON.stringify({
      complete: false, uncertain: false, conflicts: ["Painting exclusion reversed"],
    }) } });
    await expect(verifyTranslationCoverage(1, target, { description: "Joinery without painting." }))
      .rejects.toThrow("header semantic coverage");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});