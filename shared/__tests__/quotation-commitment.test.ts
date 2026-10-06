import { describe, expect, it } from "vitest";
import { quotationCommitmentStatus as status } from "../quotation-commitment";
const base = {accountingState:"active", status:"draft"};
describe("signed commitment evidence",()=>{
  it.each(["received","checked_internal","approved_for_signing","sent_for_signature","client_rejected"])("excludes unsigned stage %s", signOffStage=>{
    expect(status({...base, signOffStage})).toBe("unsigned");
  });
  it.each([
    {signOffStage:"client_signed_off"},
    {archisignEnvelopeStatus:"signed"},
    {signedPdfStorageKey:"immutable-signed-receipt"},
    {signedOffVia:"manual_upload",manualSignoffAt:new Date()},
    {status:"signed"},
  ])("accepts explicit signature evidence %j", evidence=>{
    expect(status({...base,...evidence})).toBe("signed");
  });
  it("does not mistake dispatch, provenance label or closure for signature",()=>{
    expect(status({...base,archisignEnvelopeStatus:"sent",signedOffVia:"archisign"})).toBe("unsigned");
    expect(status({...base,signedOffVia:"manual_upload"})).toBe("unsigned");
  });
  it.each(["void","cancelled","superseded"])("excludes %s even with signed evidence", value=>{
    expect(status({...base,status:value,archisignEnvelopeStatus:"signed"})).toBe("inactive");
  });
  it.each(["provisional","superseded",null])("excludes accounting state %s", accountingState=>{
    expect(status({...base,accountingState,signOffStage:"client_signed_off"})).toBe("inactive");
  });
});
