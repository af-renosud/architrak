import { describe, it, expect } from "vitest";
import { quotationExceptionReview } from "../quotation-exceptions";
import { evaluateQuotationDecision } from "../quotation-decision";
import { decisionFixture, confirmFixture } from "./fixtures/quotation-decision";
import type { ParsedDocument } from "../../gmail/document-parser";
describe("actionable extraction exceptions", () => {
  it("uses the same completeness blocker for review display and authoritative approval", async () => {
    const s = decisionFixture();
    (s.quotation.aiExtractedData as ParsedDocument).extractionCoverage = { pdfPageCount: 7, renderedPageCount: 5, chunkCount: 1 };
    const decision = await evaluateQuotationDecision(s, "approve", undefined, { verifySourceBytes: false });
    expect(decision.allowed).toBe(false);
    const display = await quotationExceptionReview(s);
    expect(display.groups.flatMap(g => g.issues).filter(i => i.code === "PAGES_NOT_EXTRACTED")).toHaveLength(1);
    expect(decision.issues.some(i => i.code === "PAGES_NOT_EXTRACTED")).toBe(true);
  });
  it("retains row and PDF page targets for an unsupported router or shifted heat-pump charge", async () => {
    const s = decisionFixture();
    (s.quotation.aiExtractedData as ParsedDocument).pricedItemVerification!.issues = [{ line: 1, page: 5, reason: "Unsupported router" }];
    const r = await quotationExceptionReview(s);
    expect(r.groups[0].issues[0]).toMatchObject({ code: "DESCRIPTION_CHARGE_UNVERIFIED", target: { rowId: s.lines[0].id, page: 5 } });
    expect(r.resolvedByHumanReview).toBe(false);
  });
  it("records current human review without rewriting the historical verdict", async () => {
    const s = confirmFixture(decisionFixture());
    const parsed = s.quotation.aiExtractedData as ParsedDocument;
    parsed.pricedItemVerification!.issues = [{ line: 1, page: 1, reason: "Unverified" }];
    s.quotation.validationWarnings = [{ field: "pricedSourceEvidence", message: "Historical" }] as any;
    Object.assign(s.translation!, { status: "finalised", approvedAt: new Date(), headerTranslated: { humanReviewed: true } });
    const before = JSON.stringify(parsed);
    const r = await quotationExceptionReview(s);
    expect(r.groups).toEqual([]);
    expect(r.resolvedByHumanReview).toBe(true);
    expect(r.historicalWarningCount).toBe(1);
    expect(JSON.stringify(parsed)).toBe(before);
    s.draft.lines[0].vatRate = "";
    expect((await quotationExceptionReview(s)).resolvedByHumanReview).toBe(false);
  });
  it("matching totals do not hide unsupported cancelling charges", async () => {
    const s = decisionFixture();
    s.lines.push({ ...s.lines[0], id: 2, lineNumber: 2, description: "Fee", totalHt: "5200.00" },
      { ...s.lines[0], id: 3, lineNumber: 3, description: "Credit", totalHt: "-5200.00" });
    (s.quotation.aiExtractedData as ParsedDocument).pricedItemVerification!.issues = [
      { line: 2, page: 2, reason: "Unsupported fee" }, { line: 3, page: 3, reason: "Unsupported credit" }];
    const r = await quotationExceptionReview(s);
    expect(r.groups.flatMap(g => g.issues).filter(i => i.code === "DESCRIPTION_CHARGE_UNVERIFIED")).toHaveLength(2);
  });
  it("clean machine-supported rows do not acquire a new manual-review requirement", async () => {
    const r = await quotationExceptionReview(decisionFixture());
    expect(r.groups).toEqual([]);
    expect(r.resolvedByHumanReview).toBe(false);
    expect(r.sourceIdentity.parser).toBe("priced-source-v1");
  });
});
