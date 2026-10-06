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
  projectId: 12, projectName: "Villa des Pins", projectCode: "VDP",
  totalContractedHt: 0, totalContractedTtc: 0, totalCertifiedHt: 0, totalCertifiedTtc: 0,
  totalResteARealiser: 0, totalResteARealiserTtc: 0,
  totalOriginalHt: 0, totalOriginalTtc: 0, totalPv: 0, totalMv: 0,
  totalPendingHt: 8740, totalPendingTtc: 10488,
  totalExcludedCertifiedHt: 1240, totalExcludedCertifiedTtc: 1488,
  financialExceptions: [unsigned], devis: [unsigned],
};

describe("CommitmentEvidenceSummary", () => {
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
