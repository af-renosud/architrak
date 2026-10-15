import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommitmentEvidenceSummary } from "../CommitmentEvidenceSummary";
import { Amount } from "@/components/ui/amount";
import type { DevisFinancialSummary, FinancialSummary } from "@/lib/financial-summary";

const unsigned: DevisFinancialSummary = {
  devisId: 81, devisCode: "DEV-081", descriptionFr: "Menuiserie", descriptionUk: null,
  status: "active", contractorId: 17, invoicingMode: "mode_a",
  commitmentStatus: "unsigned", commitmentEligible: false, hasFinancialEvidence: true,
  originalHt: 8740, originalTtc: 10488, adjustedHt: 8740, adjustedTtc: 10488,
  pvTotal: 0, mvTotal: 0, certifiedHt: 1240, certifiedTtc: 1488,
  acompteCertifiedHt: 1240, acompteCertifiedTtc: 1488,
  resteARealiser: 7500, resteARealiserTtc: 9000, invoiceCount: 0, avenantCount: 0,
};
const summary: FinancialSummary = {
  externalWorks: [], totalExternalHt: 0, totalExternalTtc: 0, totalCombinedCostHt: 0, totalCombinedCostTtc: 0,
  projectId: 12, projectName: "Villa des Pins", projectCode: "VDP",
  totalContractedHt: 0, totalContractedTtc: 0, totalCertifiedHt: 0, totalCertifiedTtc: 0,
  totalResteARealiser: 0, totalResteARealiserTtc: 0,
  totalOriginalHt: 0, totalOriginalTtc: 0, totalPv: 0, totalMv: 0,
  totalPendingHt: 8740, totalPendingTtc: 10488,
  totalExcludedCertifiedHt: 1240, totalExcludedCertifiedTtc: 1488,
  financialExceptions: [unsigned], devis: [unsigned],
};

describe("CommitmentEvidenceSummary", () => {
  it("shows signed plus pending totals immediately below pending, excluding external works and certified evidence", () => {
    const totals = {
      ...summary,
      totalContractedHt: 58025.28, totalPendingHt: 2167.50,
      totalContractedTtc: 69630.34, totalPendingTtc: 2601,
      totalExternalHt: 3210, totalExternalTtc: 3852,
      totalCombinedCostHt: 61235.28, totalCombinedCostTtc: 73482.34,
      totalCertifiedHt: 19234.56, totalCertifiedTtc: 23081.47,
      totalResteARealiser: 38790.72, totalResteARealiserTtc: 46548.87,
    };
    const before = structuredClone(totals);
    const html = renderToStaticMarkup(<CommitmentEvidenceSummary summary={totals} />);
    const label = "Signed + not signed — total quotations";
    expect(html).toContain(renderToStaticMarkup(<Amount value={60192.78} denomination="HT" />));
    expect(html).toContain(renderToStaticMarkup(<Amount value={72231.34} denomination="TTC" />));
    expect(html).toMatch(/Not signed — pending quotations<\/[^>]+><p>.*?<\/p><\/div><div data-testid="text-total-quotations-12">/);
    expect(html.indexOf(label)).toBeLessThan(html.indexOf("Certified outside signed commitment"));
    expect(html).toContain("unsigned amounts are not contractual commitment");
    expect(html).toContain("Commitment, certified and remaining totals cover signed active quotations only.");
    expect(html).toContain("DEV-081: Not signed — excluded from commitment");
    expect(html).toContain(renderToStaticMarkup(<Amount value={1488} denomination="TTC" />));
    expect(html).toContain(renderToStaticMarkup(<Amount value={1240} denomination="HT" />));
    expect(totals).toEqual(before);
  });

  it("shows signed totals when pending is zero", () => {
    const html = renderToStaticMarkup(<CommitmentEvidenceSummary summary={{
      ...summary, totalContractedHt: 58025.28, totalContractedTtc: 69630.34,
      totalPendingHt: 0, totalPendingTtc: 0,
    }} />);
    expect(html).toContain("text-total-quotations-12");
    expect(html).toContain(renderToStaticMarkup(<Amount value={58025.28} denomination="HT" />));
    expect(html).toContain(renderToStaticMarkup(<Amount value={69630.34} denomination="TTC" />));
  });

  it.each([
    "totalContractedHt", "totalContractedTtc", "totalPendingHt", "totalPendingTtc",
  ] as const)("omits combined totals when %s is missing or nonfinite", (field) => {
    for (const value of [undefined, null, NaN, Infinity, -Infinity]) {
      const incomplete = { ...summary, [field]: value } as unknown as FinancialSummary;
      const html = renderToStaticMarkup(<CommitmentEvidenceSummary summary={incomplete} />);
      expect(html).not.toContain("text-total-quotations-12");
      expect(html).not.toContain("Signed + not signed — total quotations");
      if (field !== "totalPendingHt" || value != null) {
        expect(html).toContain("text-excluded-certified-12");
        expect(html).toContain("DEV-081: Not signed — excluded from commitment");
      }
    }
  });

  it("shows pending and excluded evidence even without any signed commitment", () => {
    const html = renderToStaticMarkup(<CommitmentEvidenceSummary summary={summary} />);
    expect(html).toContain("Certified outside signed commitment");
    expect(html).toContain("text-excluded-certified-12");
    expect(html).toContain("DEV-081: Not signed — excluded from commitment");
    expect(html).toContain("Includes deposit:");
    expect(html).toContain(renderToStaticMarkup(<Amount value={1488} denomination="TTC" />));
    expect(html).toContain(renderToStaticMarkup(<Amount value={1240} denomination="HT" />));
    expect(html).toContain("TTC");
    expect(html).toContain("HT");
  });

  it("keeps inactive exceptions visible with a separate label", () => {
    const inactive = { ...unsigned, commitmentStatus: "inactive" as const, status: "void", invoiceCount: 1 };
    const html = renderToStaticMarkup(<CommitmentEvidenceSummary summary={{ ...summary, totalPendingHt: 0, totalPendingTtc: 0, financialExceptions: [inactive] }} />);
    expect(html).toContain("Inactive — excluded from commitment");
    expect(html).toContain("1 invoice");
    expect(html).toContain("text-financial-exception-81");
  });

  it("handles a pre-rollout response without rendering invented totals", () => {
    const legacy = { ...summary, totalPendingHt: undefined, totalExcludedCertifiedHt: undefined };
    expect(renderToStaticMarkup(<CommitmentEvidenceSummary summary={legacy as unknown as FinancialSummary} />)).toBe("");
  });
});
