import { describe, expect, it } from "vitest";
import { insertDevisSchema } from "@shared/schema";
import { signedCopyDeliveryReference } from "../signed-devis-contractor-copy.service";

describe("signed devis contractor-copy safety primitives", () => {
  it("builds a stable searchable reference without exposing the envelope id", () => {
    const notice = { id: 42, archisignEnvelopeId: "sensitive-envelope-123" };
    const first = signedCopyDeliveryReference(notice as never);
    expect(first).toMatch(/^AT-DV-[a-f0-9]{20}$/);
    expect(first).toBe(signedCopyDeliveryReference(notice as never));
    expect(first).not.toContain(notice.archisignEnvelopeId);
  });

  it("strips every signed-PDF server field from generic devis input", () => {
    const parsed = insertDevisSchema.parse({
      projectId: 1,
      contractorId: 2,
      devisCode: "DV-1",
      descriptionFr: "Test",
      amountHt: "100.00",
      amountTtc: "120.00",
      signedPdfStorageKey: "/private/unrelated.pdf",
      signedPdfArchisignEnvelopeId: "forged-envelope",
      signedPdfFetchUrlSnapshot: "https://attacker.invalid/file.pdf",
      signedPdfRetryAttempts: 0,
      signedPdfNextAttemptAt: new Date(),
      signedPdfLastError: null,
    });
    expect(parsed).not.toHaveProperty("signedPdfStorageKey");
    expect(parsed).not.toHaveProperty("signedPdfArchisignEnvelopeId");
    expect(parsed).not.toHaveProperty("signedPdfFetchUrlSnapshot");
    expect(parsed).not.toHaveProperty("signedPdfRetryAttempts");
    expect(parsed).not.toHaveProperty("signedPdfNextAttemptAt");
    expect(parsed).not.toHaveProperty("signedPdfLastError");
  });
});