import { expect, it } from "vitest";
import { isReviewedMasseyDepositRelationship } from "../massey-deposit-recovery";

it("recognizes only the explicitly reviewed legacy relationship, never an amount-only match", () => {
  const invoice = { id: 6, projectId: 12, contractorId: 37, devisId: 34, sourceIntakeDocumentId: 114,
    invoiceNumber: "DV260940", aiExtractedData: { relationshipResolution: {
      sourceFingerprint: "291081ba2e570b1cc57ad7272956ad2b4b778b491bfe139fdf9fde76bd7f5cbf",
    } } };
  const certificate = { id: 5, projectId: 12, contractorId: 37, certificateRef: "C1",
    totalWorksHt: "19002.00", retenueGarantie: "950.10", tvaAmount: "1805.19", previousPayments: "0.00" };
  expect(isReviewedMasseyDepositRelationship(invoice, certificate)).toBe(true);
  expect(isReviewedMasseyDepositRelationship({ ...invoice, id: 7 }, certificate)).toBe(false);
  expect(isReviewedMasseyDepositRelationship(invoice, { ...certificate, id: 6 })).toBe(false);
  expect(isReviewedMasseyDepositRelationship({ ...invoice, sourceIntakeDocumentId: 115 }, certificate)).toBe(false);
  expect(isReviewedMasseyDepositRelationship({ ...invoice, aiExtractedData: {} }, certificate)).toBe(false);
  expect(isReviewedMasseyDepositRelationship(invoice, { ...certificate, retenueGarantie: "0.00" })).toBe(false);
});
