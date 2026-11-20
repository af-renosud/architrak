import { describe, expect, it } from "vitest";
import type { Devis } from "@shared/schema";
import { clientSignedPdfKey, isAutomaticSignedQuotation } from "../client-project-signed-quotation";
const signed = { status:"draft",accountingState:"active",signOffStage:"client_signed_off",
  signedOffVia:null,archisignEnvelopeId:"envelope",signedPdfArchisignEnvelopeId:"envelope",signedPdfStorageKey:"signed" } as Devis;
describe("automatic signed client records", () => {
  it("recognises signed active work and serves only provenance-matched signed bytes", () => {
    expect(isAutomaticSignedQuotation(signed)).toBe(true);
    expect(clientSignedPdfKey(signed)).toBe("signed");
    expect(clientSignedPdfKey({...signed,signedPdfArchisignEnvelopeId:"old-envelope"})).toBeNull();
    expect(clientSignedPdfKey({...signed,signedPdfStorageKey:null})).toBeNull();
  });
  it.each([{status:"void"},{status:"cancelled"},{accountingState:"superseded"},
    {accountingState:"provisional"},{signOffStage:"void"}])("excludes inactive records %s", patch => {
    expect(isAutomaticSignedQuotation({...signed,...patch})).toBe(false);
    expect(clientSignedPdfKey({...signed,...patch})).toBeNull();
  });
  it("requires manual attestation and never treats an original PDF as signed", () => {
    const manual = {...signed,signedOffVia:"manual_upload",signedPdfArchisignEnvelopeId:null};
    expect(clientSignedPdfKey(manual)).toBeNull();
    expect(clientSignedPdfKey({...manual,manualSignoffBy:"Architect",manualSignoffNote:"Signed original checked",manualSignoffAt:new Date()})).toBe("signed");
    expect(clientSignedPdfKey({...signed,signedPdfStorageKey:null,pdfStorageKey:"original"})).toBeNull();
  });
});
