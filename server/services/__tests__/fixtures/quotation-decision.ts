import type { QuotationDecisionSnapshot } from "../../quotation-decision-snapshot";
import { cleanImport, roofDraft, sourceDigest, workingRow } from "./quotation-workflow";

/** Fully synthetic, used with a mocked snapshot boundary, not a mocked decision. */
export function decisionFixture(): QuotationDecisionSnapshot {
  return {
    quotation: { id: 901, projectId: 902, status: "draft", signOffStage: "received", accountingState: "active",
      amountHt: "100.00", amountTtc: "120.00", pdfStorageKey: "synthetic.pdf", aiExtractedData: cleanImport() } as QuotationDecisionSnapshot["quotation"],
    lines: [workingRow(1, "Roof repair")],
    translation: { devisId: 901, status: "draft", contextsVersion: 0, headerTranslated: { description: "Roof repair" },
      lineTranslations: [{ lineNumber: 1, originalDescription: "Roof repair", translation: "Roof repair", edited: false }] } as QuotationDecisionSnapshot["translation"],
    baseline: null, archived: false, hasCorrection: false, draft: roofDraft(),
  };
}
export function confirmFixture(s: QuotationDecisionSnapshot) {
  s.baseline = { ttc: "120.00", sourceDigest, storageKey: "synthetic.pdf" };
  return s;
}
