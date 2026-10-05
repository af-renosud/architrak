import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ translation: vi.fn() }));
vi.mock("../storage", () => ({ storage: {
  getProject: vi.fn(async () => ({ name: "Fixture project" })),listClientChecks: vi.fn(async () => []),
  getDevisLineItems: vi.fn(async () => [{ id: 7,lineNumber: 1,description: "French approved specification",quantity: "1",unit: "u",unitPriceHt: "87.50",totalHt: "87.50" }]),
  getDevisTranslation: mocks.translation,
} }));
vi.mock("../communications/devis-translation-generator", () => ({
  loadLineContextRenders: vi.fn(async () => new Map()),generateCombinedPdf: vi.fn(),getValidatedCachedPdfKey: vi.fn(),
}));
vi.mock("../services/devis-cost-analysis", () => ({ getConfirmedCostAnalysisDocument: vi.fn(async () => null) }));
import { buildClientPortalPayload } from "../routes/public-client-checks";
const quote = { id: 42,projectId: 1,devisCode: "TEST",descriptionFr: "Human working header",descriptionUk: null,
  amountHt: "87.50",amountTtc: "96.25",pdfStorageKey: "immutable-original.pdf" } as any;
beforeEach(() => vi.clearAllMocks());
describe("human-approved working quotation portal", () => {
  it("does not publish unapproved corrected French or financial figures through an existing portal token", async () => {
    mocks.translation.mockResolvedValue({ status: "edited",headerTranslated: { workingDiscountHt: "0.00" },lineTranslations: [] });
    const payload = await buildClientPortalPayload(quote,null);
    expect(payload?.lineItems).toEqual([]); expect(payload?.devis.amountTtc).toBeNull();
    expect(payload?.packageAvailable).toBe(false); expect(JSON.stringify(payload)).not.toContain("Human working header");
  });
  it("publishes approved bilingual explanations and labels options without treating them as accepted charges", async () => {
    mocks.translation.mockResolvedValue({ status: "finalised",
      headerTranslated: { workingDiscountHt: "0.00",description: "Human English header",descriptionExplanationFr: "Explication FR",descriptionExplanation: "Explanation EN" },
      lineTranslations: [{ lineNumber: 1,translation: "Human English specification",explanationFr: "<script>FR context</script>",
        explanation: "EN context",kind: "priced",included: false }] });
    const payload = await buildClientPortalPayload(quote,null);
    expect(payload?.lineItems[0].translationEn).toBe("Human English specification");
    expect(payload?.lineItems[0].contextHtml).toContain("excluded from the quotation total");
    expect(payload?.lineItems[0].contextHtml).toContain("&lt;script&gt;"); expect(payload?.lineItems[0].contextHtml).not.toContain("<script>");
    expect(payload?.translationExplanationFr).toBe("Explication FR");
    expect(payload?.devis.amountTtc).toBe("96.25"); expect(payload?.packageAvailable).toBe(true);
  });
});
