import { describe, expect, it } from "vitest";
import { canBulkDeleteIntake, canBulkDeletePlanning, canBulkDiscardInvoice, canBulkVoidDevis } from "../bulk-document-eligibility";

describe("document removal eligibility", () => {
  it("only voids unlocked, unsigned drafts through the allowed lifecycle", () => {
    expect(canBulkVoidDevis({ status: "draft" }, false)).toBe(true);
    for (const status of ["pending", "signed", "void"]) expect(canBulkVoidDevis({ status }, false)).toBe(false);
    for (const lock of [{ dateSigned: "2026-06-01" }, { archisignEnvelopeId: "188" }, { archisignPinnedPdfStorageKey: "snapshot.pdf" }, { signedPdfStorageKey: "signed.pdf" }, { signOffStage: "sent_to_client" }, { signOffStage: "client_signed_off" }, { accountingState: "superseded" }]) {
      expect(canBulkVoidDevis({ status: "draft", ...lock }, false)).toBe(false);
    }
    expect(canBulkVoidDevis({ status: "draft" }, true)).toBe(false);
  });
  it("protects promoted, processing and known identity/deposit intake evidence", () => {
    const doc = { analysisState: "analyzed", routingState: "parked", promotedId: null };
    expect(canBulkDeleteIntake(doc, false)).toBe(true);
    expect(canBulkDeleteIntake({ ...doc, promotedId: 11 }, false)).toBe(false);
    for (const analysisState of ["pending", "analyzing"]) expect(canBulkDeleteIntake({ ...doc, analysisState }, false)).toBe(false);
    expect(canBulkDeleteIntake({ ...doc, routingState: "unrouted" }, false)).toBe(false);
    for (const extractedData of [{ projectIdentityResolution: { confirmed: true } }, { openingAcompteResolution: {} }]) {
      expect(canBulkDeleteIntake({ ...doc, extractedData }, false)).toBe(false);
    }
    expect(canBulkDeleteIntake(doc, true)).toBe(false);
  });
  it("excludes approved, paid, certified and deposit-linked invoices", () => {
    const invoice = { id: 18, status: "draft" };
    expect(canBulkDiscardInvoice(invoice, false, false, false)).toBe(true);
    expect(canBulkDiscardInvoice({ ...invoice, status: "approved" }, false, false, false)).toBe(false);
    expect(canBulkDiscardInvoice({ ...invoice, datePaid: "2026-06-01" }, false, false, false)).toBe(false);
    expect(canBulkDiscardInvoice(invoice, false, true, false)).toBe(false);
    expect(canBulkDiscardInvoice(invoice, false, false, true)).toBe(false);
    expect(canBulkDiscardInvoice(invoice, true, false, false)).toBe(false);
  });
  it("selects only unpromoted planning drafts, never imports or approved history", () => {
    expect(canBulkDeletePlanning({ status: "draft" }, false, false)).toBe(true);
    for (const status of ["reviewed", "approved", "superseded"]) expect(canBulkDeletePlanning({ status }, false, false)).toBe(false);
    expect(canBulkDeletePlanning({ status: "draft", promotedDevisId: 8 }, false, false)).toBe(false);
    expect(canBulkDeletePlanning({ status: "draft", promotedAt: "2026-06-01" }, false, false)).toBe(false);
    expect(canBulkDeletePlanning({ status: "draft" }, false, true)).toBe(false);
    expect(canBulkDeletePlanning({ status: "draft" }, true, false)).toBe(false);
  });
});
