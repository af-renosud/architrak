import { describe, it, expect } from "vitest";
import { buildProjectOverviewData, buildProjectOverviewHtml } from "../project-overview-pdf.service";
import { buildProjectSummaryHtml } from "../../communications/certificat-generator";
import { externalOverviewFromSummary } from "../external-works-reporting";

const summary = {
  projectName: "Example", projectCode: "EX", devis: [], totalContractedHt: 100, totalContractedTtc: 120,
  totalCertifiedHt: 20, totalCertifiedTtc: 24, totalResteARealiser: 80, totalResteARealiserTtc: 96,
  externalWorks: [{ id: 1, reference: "OLD-1", description: "Completed work", amountHt: "50.01", amountTtc: "52.76", companyName: null, lot: null, completionDate: null }],
  totalExternalHt: 50.01, totalExternalTtc: 52.76, totalCombinedCostHt: 150.01, totalCombinedCostTtc: 172.76,
};
describe("historical project reporting", () => {
  it("keeps the overview's managed progress and payable fields unchanged", () => {
    const data = buildProjectOverviewData(summary, null);
    expect(data).toMatchObject({ totalContractedHt: 100, totalCertifiedHt: 20, totalResteARealiser: 80, progressPercent: 20,
      externalOverview: { totalExternalHt: 50.01, totalCombinedCostTtc: 172.76 } });
    const html = buildProjectOverviewHtml(data, null);
    expect(html).toContain("External works completed before ArchiTrak");
    expect(html).toContain("150,01");
    expect(html).toContain("172,76");
  });
  it("prints itemised historical references separately on certificates", () => {
    const html = buildProjectSummaryHtml({ ...summary, rows: [], externalOverview: externalOverviewFromSummary(summary) });
    expect(html).toContain("OLD-1");
    expect(html).toContain("Completed work");
    expect(html).toContain("52,76");
    expect(html).toContain("Combined project cost");
    expect(html).toContain("not amounts certified or confirmed paid");
  });
  it("does not invent missing monetary totals or display a large empty section", () => {
    expect(externalOverviewFromSummary({})).toBeNull();
    expect(() => externalOverviewFromSummary({ externalWorks: summary.externalWorks })).toThrow("incomplete");
  });
});
