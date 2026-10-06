import { describe, it, expect } from "vitest";
import { buildProjectSummaryHtml } from "../communications/certificat-generator";
describe("certificate signed commitment disclosure", () => {
  it("shows the Massey signed subtotal and keeps the unsigned quotation outside it", () => {
    const html = buildProjectSummaryHtml({
      rows:[{devisCode:"DM.1.DIVERS",description:"Demolition",adjustedHt:63340,certifiedHt:0,resteARealiser:63340}],
      totalContractedHt:63340,totalContractedTtc:69674,
      totalCertifiedHt:0,totalCertifiedTtc:0,totalResteARealiser:63340,totalResteARealiserTtc:69674,
      excludedRows:[{devisCode:"MN.1.ALU",commitmentStatus:"unsigned",adjustedHt:32405,adjustedTtc:34187.28,certifiedHt:0,certifiedTtc:0}],
    });
    const [signed, excluded] = html.split("Outside signed commitment totals");
    expect(signed).toContain("DM.1.DIVERS");
    expect(signed).not.toContain("MN.1.ALU");
    expect(signed).toContain("63\u202f340,00");
    expect(signed).toContain("69\u202f674,00");
    expect(excluded).toContain("MN.1.ALU");
    expect(excluded).toContain("Not signed — excluded from commitment");
  });
  it("shows an unsigned-only project and its financial evidence without claiming commitment", () => {
    const html = buildProjectSummaryHtml({rows:[],totalContractedHt:0,totalContractedTtc:0,
      totalCertifiedHt:0,totalCertifiedTtc:0,totalResteARealiser:0,totalResteARealiserTtc:0,
      excludedRows:[{devisCode:"<pending>",commitmentStatus:"unsigned",adjustedHt:100,adjustedTtc:120,certifiedHt:30,certifiedTtc:36,hasFinancialEvidence:true}]});
    expect(html).toContain("No signed commitments");
    expect(html).toContain("&lt;pending&gt;");
    expect(html).toContain("review required");
    expect(html).toContain("36,00");
  });
});
