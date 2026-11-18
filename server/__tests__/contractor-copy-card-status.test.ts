import { describe, expect, it } from "vitest";
import { matchesCurrentSignedCopy } from "../services/contractor-copy-card-status";
const devis = { id: 1, projectId: 2, contractorId: 3, signedPdfStorageKey: "signed/one.pdf", archisignEnvelopeId: "e1", signedOffVia: "archisign" } as any;
const notice = { devisId: 1, projectId: 2, intendedContractorId: 3, archisignEnvelopeId: "e1", status: "sent" } as any;
const comm = { attachmentStorageKeys: ["signed/one.pdf"] } as any;
describe("contractor delivery identity", () => {
  it("matches the stored signed document and exact quotation", () => {
    expect(matchesCurrentSignedCopy(devis, notice, comm)).toBe(true);
  });
  it.each([
    { id: 9 }, { projectId: 9 }, { contractorId: 9 },
    { archisignEnvelopeId: "e2" }, { signedPdfStorageKey: "signed/replacement.pdf" },
    { signedPdfStorageKey: null }, { signedOffVia: "manual_upload" },
  ])("rejects changed provenance %j", change => {
    expect(matchesCurrentSignedCopy({ ...devis, ...change }, notice, comm)).toBe(false);
  });
  it("does not accept sent records without attachment evidence", () => {
    expect(matchesCurrentSignedCopy(devis, notice)).toBe(false);
  });
});
