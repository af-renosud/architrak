import { describe, it, expect } from "vitest";
import {
  evaluateDevisReopen,
  evaluateInvoiceReopen,
  type DevisReopenInput,
} from "../draft-reopen.rules";

const eligibleDevis: DevisReopenInput = {
  status: "pending",
  signOffStage: "received",
  invoiceCount: 0,
  situationCount: 0,
};

describe("evaluateDevisReopen", () => {
  it("allows a pending devis with no downstream effects", () => {
    expect(evaluateDevisReopen(eligibleDevis)).toEqual({ ok: true });
  });

  it("refuses a devis that is already a draft", () => {
    const v = evaluateDevisReopen({ ...eligibleDevis, status: "draft" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/already a draft/i);
  });

  it("refuses a void devis", () => {
    const v = evaluateDevisReopen({ ...eligibleDevis, status: "void" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/only pending/i);
  });

  it("refuses approved/signed statuses", () => {
    for (const status of ["approved", "signed"]) {
      const v = evaluateDevisReopen({ ...eligibleDevis, status });
      expect(v.ok).toBe(false);
    }
  });

  it("refuses once the sign-off workflow has started (any stage past received)", () => {
    for (const stage of [
      "checked_internal",
      "client_review_in_progress",
      "client_agreed",
      "approved_for_signing",
      "sent_to_client",
      "client_signed_off",
      "client_rejected",
      "void",
    ]) {
      const v = evaluateDevisReopen({ ...eligibleDevis, signOffStage: stage });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/sign-off/i);
    }
  });

  it("refuses when invoices reference the devis", () => {
    const v = evaluateDevisReopen({ ...eligibleDevis, invoiceCount: 1 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/invoices/i);
  });

  it("refuses when situations reference the devis", () => {
    const v = evaluateDevisReopen({ ...eligibleDevis, situationCount: 2 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/situations/i);
  });
});

describe("evaluateInvoiceReopen", () => {
  it("allows a pending invoice", () => {
    expect(evaluateInvoiceReopen({ status: "pending" })).toEqual({ ok: true });
  });

  it("refuses an invoice that is already a draft", () => {
    const v = evaluateInvoiceReopen({ status: "draft" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/already a draft/i);
  });

  it("refuses an approved invoice with a commission-specific message", () => {
    const v = evaluateInvoiceReopen({ status: "approved" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/commission/i);
  });

  it("refuses any other status", () => {
    const v = evaluateInvoiceReopen({ status: "paid" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/only pending/i);
  });
});
