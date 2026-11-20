import { describe, it, expect, vi } from "vitest";
import { evaluateQuotationDecision } from "../quotation-decision";
import { deriveDevisReadiness } from "../devis-readiness";
import { quotationDecisionVersion, quotationPackageVersion } from "../quotation-decision-snapshot";
import { decisionFixture, confirmFixture } from "./fixtures/quotation-decision";
import { sourceBytes } from "./fixtures/quotation-workflow";
const ready = () => {
  const s = confirmFixture(decisionFixture());
  Object.assign(s.quotation, { invoicingMode: "mode_b", signOffStage: "approved_for_signing", lotId: 1, descriptionUk: "Roof" });
  Object.assign(s.translation!, { status: "finalised", approvedAt: new Date(), headerTranslated: { humanReviewed: true } });
  return s;
};
describe("source, financial and signing decisions stay consistent", () => {
  it("resolved human review replaces historical machine warnings on the card", async () => {
    const s = ready();
    s.quotation.aiExtractedData = { illustratedRecovery: {}, quotationVerification: { verified: false } };
    const readPdf = vi.fn(async () => sourceBytes);
    const decision = await evaluateQuotationDecision(s, "sign", readPdf, { verifySourceBytes: false });
    const card = deriveDevisReadiness({ devis: s.quotation, sourceDecision: decision, translationStatus: "finalised",
      openClientChecks: 0, openContractorChecks: 0, clientContactPresent: true,
      insurance: { ok: true, reason: "" }, insuranceOverridden: false });
    expect(card.readyToSend).toBe(true);
    expect(readPdf).not.toHaveBeenCalled();
    expect(decision.issues.map(i => i.code)).toContain("SOURCE_RECHECK_AT_COMMIT");
    expect((await evaluateQuotationDecision(s, "sign", readPdf)).allowed).toBe(true);
    expect(readPdf).toHaveBeenCalledTimes(1);
  });
  it("all financial fields are reported together, without blocking wording saves", async () => {
    const s = ready(); s.draft.lines[0].vatRate = "";
    s.draft.lines.push({ ...s.draft.lines[0], id: 2, clientKey: "line-2" });
    const codes = [];
    for (const action of ["approve", "advance", "client_link", "sign"] as const) {
      const decision = await evaluateQuotationDecision(s, action, async () => sourceBytes);
      const issues = decision.issues.filter(i => i.target.section === "financial");
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(issues.every(i => i.target.field)).toBe(true);
      codes.push(issues.map(i => i.code));
    }
    expect(codes.every(c => JSON.stringify(c) === JSON.stringify(codes[0]))).toBe(true);
    expect((await evaluateQuotationDecision(s, "save_content")).allowed).toBe(true);
  });
  it("mode A can send a machine-backed draft; mode B still needs approval", async () => {
    const s = decisionFixture();
    s.quotation.signOffStage = "approved_for_signing";
    s.quotation.invoicingMode = "mode_a";
    expect((await evaluateQuotationDecision(s, "sign", async () => sourceBytes)).allowed).toBe(true);
    s.quotation.invoicingMode = "mode_b";
    expect((await evaluateQuotationDecision(s, "sign", async () => sourceBytes)).issues.map(i => i.code)).toContain("TRANSLATION_NOT_APPROVED");
  });
  it("provisional blocks client publication, while source review remains possible", async () => {
    const s = ready(); s.quotation.accountingState = "provisional";
    expect((await evaluateQuotationDecision(s, "approve", async () => sourceBytes)).allowed).toBe(true);
    expect((await evaluateQuotationDecision(s, "client_link", async () => sourceBytes)).issues.map(i => i.code)).toContain("ACCOUNTING_PROVISIONAL");
  });
  it("package binding ignores transport/cache metadata but not context or baseline changes", () => {
    const s = ready(), before = quotationPackageVersion(s), decision = quotationDecisionVersion(s);
    s.quotation.archisignEnvelopeId = "new-envelope";
    s.quotation.updatedAt = new Date();
    s.translation!.combinedPdfStorageKey = "generated-cache";
    expect(quotationPackageVersion(s)).toBe(before);
    expect(quotationDecisionVersion(s)).not.toBe(decision);
    s.translation!.contextsVersion++;
    expect(quotationPackageVersion(s)).not.toBe(before);
    const afterContext = quotationPackageVersion(s);
    s.baseline!.sourceDigest = "changed";
    expect(quotationPackageVersion(s)).not.toBe(afterContext);
  });
  it("technical source failure never passes authoritative publication", async () => {
    const decision = await evaluateQuotationDecision(ready(), "client_link", async () => { throw new Error("offline"); });
    expect(decision.allowed).toBe(false);
    expect(decision.issues.map(i => i.code)).toContain("SOURCE_UNAVAILABLE");
  });
});
