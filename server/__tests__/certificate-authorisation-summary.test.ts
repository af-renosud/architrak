import { describe, expect, it } from "vitest";
import { certificateAuthorisationSummary } from "../services/certificate-authorisation-summary";

const issuedAt = new Date("2026-11-17T12:00:00Z");
const certificate = (id: number, contractorId: number, ht: string, ttc: string) => ({
  id, contractorId, netToPayHt: ht, netToPayTtc: ttc, status: "sent", issuedAt,
});
const commitments = [
  {contractorId: 28, devisCode: "SURVEY", commitmentEligible: true, adjustedHt: 2075, adjustedTtc: 2490},
  {contractorId: 40, devisCode: "GEO", commitmentEligible: true, adjustedHt: 5800, adjustedTtc: 6960},
  {contractorId: 95, devisCode: "ET", commitmentEligible: true, adjustedHt: 6000, adjustedTtc: 7200},
];
const certs = [
  certificate(1, 28, "1240", "1488"), certificate(2, 28, "835", "1002"),
  certificate(3, 40, "4600", "5520"), certificate(4, 95, "3000", "3600"),
];
describe("issued certificate authorisations", () => {
  it("includes manual certificates and counts period amounts once, regardless of payment confirmation", () => {
    const result = certificateAuthorisationSummary(commitments, certs, certs[3]);
    expect(result.totalCertifiedHt).toBe(9675);
    expect(result.totalCertifiedTtc).toBe(11610);
    expect(result.totalResteARealiserTtc).toBe(5040);
    expect(result.rows.map(r => r.certifiedHt)).toEqual([2075,4600,3000]);
    expect(certificateAuthorisationSummary(commitments, certs.map(c => ({...c,status:"paid"})), certs[3])).toEqual(result);
  });
  it("includes the current draft during sealing but excludes other unissued drafts and later issues", () => {
    const current = {...certs[3], status:"draft",issuedAt:null};
    const draft = {...certificate(5,95,"999","1198.80"),status:"ready",issuedAt:null};
    expect(certificateAuthorisationSummary(commitments,[...certs.slice(0,3),current,draft],current).totalCertifiedTtc).toBe(11610);
    const future = {...certificate(6,95,"999","1198.80"),issuedAt:new Date("2026-11-18")};
    expect(certificateAuthorisationSummary(commitments,[...certs,future],certs[3]).totalCertifiedTtc).toBe(11610);
  });
  it("excludes superseded certificates and the original while a reissue is being sealed", () => {
    const replacement = {...certificate(5,95,"3000","3600"),status:"draft",issuedAt:null,reissuedFromCertificatId:4};
    expect(certificateAuthorisationSummary(commitments,[...certs,replacement],replacement).totalCertifiedTtc).toBe(11610);
    expect(certificateAuthorisationSummary(commitments,[...certs.map(c=>c.id===4?{...c,status:"superseded"}:c),replacement],replacement).totalCertifiedTtc).toBe(11610);
  });
  it("groups multiple quotations without guessing certificate allocations", () => {
    const extra = {...commitments[2],devisCode:"ET2"};
    const result = certificateAuthorisationSummary([...commitments,extra],certs,certs[3]);
    expect(result.rows[2].codes).toEqual(["ET","ET2"]);
    expect(result.rows[2].certifiedTtc).toBe(3600);
  });
  it("does not mix supplier-track authorisations into contractor works", () => {
    const supplier = {...certificate(9,95,"500","600"),certificateTrack:"supplier_direct_payment"};
    expect(certificateAuthorisationSummary(commitments,[...certs,supplier],certs[3]).totalCertifiedTtc).toBe(11610);
  });
  it("retains unallocated authorisations without claiming an unsigned commitment", () => {
    const result = certificateAuthorisationSummary(commitments.map(d=>({...d,commitmentEligible:false})),certs,certs[3]);
    expect(result.totalContractedTtc).toBe(0);
    expect(result.totalCertifiedTtc).toBe(11610);
    expect(result.rows.every(r=>r.codes.length===0)).toBe(true);
  });
});
