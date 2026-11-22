import { describe, expect, it, vi } from "vitest";
import { evaluateQuotationDecision } from "../quotation-decision";
import type { QuotationDecisionSnapshot } from "../quotation-decision-snapshot";
import { quotationAmountsUnavailable } from "@shared/quotation-amount-availability";

const snapshot = (): QuotationDecisionSnapshot => ({
  quotation: { id: 1, status: "draft", signOffStage: "received", accountingState: "provisional",
    descriptionFr: "Rénovation de toiture", pdfStorageKey: "original.pdf", amountHt: "0", amountTtc: "0",
    manualIntakeReviewRequired: true, aiExtractedData: { documentType: "unknown" } } as any,
  translation: { status: "edited", headerTranslated: { description: "Roof renovation" }, lineTranslations: [] } as any,
  lines: [], baseline: null, archived: false, hasCorrection: false,
  draft: { headerFr: "Rénovation de toiture", headerEn: "Roof renovation", explanationFr: "", explanationEn: "",
    summaryEn: "", discountHt: "0", lines: [] },
});
describe("incomplete quotation action boundaries", () => {
  it("allows registration, wording, translation preparation and budget review without certifying figures", async () => {
    for (const action of ["register", "save_content", "prepare_translation", "indicative_budget"] as const) {
      const readPdf = vi.fn();
      expect((await evaluateQuotationDecision(snapshot(), action, readPdf)).allowed).toBe(true);
      expect(readPdf).not.toHaveBeenCalled();
    }
    for (const action of ["approve", "advance", "client_link", "sign", "save_financial"] as const) {
      expect((await evaluateQuotationDecision(snapshot(), action)).allowed).toBe(false);
    }
  });
  it("does not translate a filename placeholder or approve empty English", async () => {
    const s = snapshot();
    s.quotation.descriptionFr = "Unparsed.pdf"; s.quotation.pdfFileName = "Unparsed.pdf";
    expect((await evaluateQuotationDecision(s, "prepare_translation")).allowed).toBe(false);
    s.quotation.descriptionFr = "Description entered by the architect";
    expect((await evaluateQuotationDecision(s, "prepare_translation")).allowed).toBe(true);
    s.translation!.headerTranslated = {};
    expect((await evaluateQuotationDecision(s, "approve")).issues.some(issue => issue.code === "TRANSLATION_INCOMPLETE")).toBe(true);
  });
  it("keeps archived, void and replaced drafts read-only and requires a source for budget review", async () => {
    for (const state of ["archived", "void", "superseded"]) {
      const s = snapshot();
      if (state === "archived") s.archived = true;
      else s.quotation.status = state as any;
      for (const action of ["register", "save_content", "prepare_translation", "indicative_budget"] as const)
        expect((await evaluateQuotationDecision(s, action)).allowed).toBe(false);
    }
    const s = snapshot(); s.quotation.pdfStorageKey = null;
    expect((await evaluateQuotationDecision(s, "indicative_budget")).allowed).toBe(false);
  });
  it("does not present a copied single amount as a complete HT/TTC pair", () => {
    expect(quotationAmountsUnavailable({ manualIntakeReviewRequired: true, amountHt: 100, amountTtc: 100,
      aiExtractedData: { amountHt: 100 } })).toBe(true);
    expect(quotationAmountsUnavailable({ manualIntakeReviewRequired: true, amountHt: 0, amountTtc: 0,
      aiExtractedData: { amountHt: 0, amountTtc: 0 } })).toBe(false);
  });
});
