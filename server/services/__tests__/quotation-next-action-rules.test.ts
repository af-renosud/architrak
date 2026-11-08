import { describe, expect, it } from "vitest";
import type { Certificat, CertificatPayment, Devis } from "@shared/schema";
import { deriveQuotationNextActions, type CertificateActionEvidence, type QuotationActionEvidence } from "../quotation-next-action-rules";
import { deriveDevisReadiness } from "../devis-readiness";

// Readiness is imported only for its pure helper; avoid a database connection.
import { vi } from "vitest";
vi.mock("../../storage", () => ({ storage: {} }));
vi.mock("../insurance-verdict", () => ({ evaluateInsuranceMirrorPreloaded: vi.fn() }));

const devis = { id: 1, projectId: 9, contractorId: 2, status: "pending", accountingState: "active",
  signOffStage: "client_signed_off", acompteRequired: true, acompteState: "pending", acomptePercent: "30",
  amountHt: "1000.00", amountTtc: "1200.00",
  invoicingMode: "mode_b", lotId: 3, descriptionUk: "Works" } as Devis;
const certificate = { id: 10, projectId: 9, contractorId: 2, acompteDevisId: 1,
  certificateRef: "C1", status: "draft", netToPayTtc: "120.00" } as Certificat;
function cert(patch: Partial<Certificat> = {}, evidence: Partial<CertificateActionEvidence> = {}): CertificateActionEvidence {
  return { certificate: { ...certificate, ...patch }, deposit: true, payments: [], delivered: false,
    pendingEvidence: false, failedDelivery: false, ...evidence };
}
const derive = (certificates: CertificateActionEvidence[] = [], patch: Partial<QuotationActionEvidence> = {}) =>
  deriveQuotationNextActions({ devis, archived: false, certificates, ...patch });
const payment = (amount: string) => ({ amount } as CertificatPayment);

describe("verified quotation actions", () => {
  it("suggests preparing a deposit only when signed and still pending", () => {
    const result = derive();
    expect(result.actionable).toBe(true);
    expect(result.actions[0]).toMatchObject({ code: "prepare_deposit", target: "deposit", tone: "action" });
  });
  it("asks for deposit details rather than suggesting generation with no amount", () => {
    expect(derive([], { devis: { ...devis, acomptePercent: null, acompteAmountHt: null } }).actions[0].code)
      .toBe("review_deposit_amount");
  });
  it("reviews a draft rather than creating a duplicate or claiming payment is due", () => {
    const result = derive([cert()]);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ code: "review_certificate", certificateRef: "C1", certificateId: 10 });
    expect(result.actions[0].outstandingTtc).toBeUndefined();
  });
  it.each(["ready", "sent"])("requires delivery evidence despite certificate status %s", status => {
    expect(derive([cert({ status })]).actions[0].code).toBe("send_certificate");
  });
  it("shows the exact remaining balance and waits for the client after delivery", () => {
    const result = derive([cert({ status: "sent" }, { delivered: true, payments: [payment("20.00")] })]);
    expect(result.actionable).toBe(false);
    expect(result.actions[0]).toMatchObject({ code: "await_payment", actor: "client", tone: "waiting", outstandingTtc: "100.00" });
    expect(result.actions[0].why).not.toMatch(/overdue/);
  });
  it("pending evidence replaces payment waiting and prevents a new demand", () => {
    const result = derive([cert({ status: "ready" }, { pendingEvidence: true })]);
    expect(result.actions.map(a => a.code)).toEqual(["verify_payment"]);
  });
  it("fully paid suppresses even pending evidence without a second payment prompt", () => {
    expect(derive([cert({ status: "sent" }, { delivered: true, pendingEvidence: true, payments: [payment("120.00")] })]).actions).toEqual([]);
  });
  it("legacy status-only paid is unknown, not another payment request", () => {
    const result = derive([cert({ status: "paid" })]);
    expect(result.actionable).toBe(false);
    expect(result.actions[0]).toMatchObject({ code: "legacy_paid", tone: "unknown" });
  });
  it("only a failed delivery without a later success is red", () => {
    expect(derive([cert({ status: "ready" }, { failedDelivery: true })]).actions[0].tone).toBe("blocked");
    expect(derive([cert({ status: "sent" }, { failedDelivery: true, delivered: true })]).actions[0].tone).toBe("waiting");
  });
  it("an in-flight delivery is waiting, not a second send prompt", () => {
    expect(derive([cert({ status: "ready" }, { pendingDelivery: true, failedDelivery: true })]).actions[0])
      .toMatchObject({ code: "delivery_pending", actor: "system", tone: "waiting" });
  });
  it("a deposit already recorded as paid never becomes a new payment demand", () => {
    expect(derive([cert({ status: "ready" })], { devis: { ...devis, acompteState: "paid" } }).actions[0])
      .toMatchObject({ code: "legacy_paid", tone: "unknown" });
  });
  it.each(["NaN", "", "-10", "120bad"])("invalid amount %s is not reported as zero or payable", netToPayTtc => {
    expect(derive([cert({ netToPayTtc })]).actions[0]).toMatchObject({ code: "payment_unknown", tone: "unknown" });
  });
  it("does not create active recommendations for archived, void, superseded or cancelled records", () => {
    expect(derive([], { archived: true }).actions).toEqual([]);
    for (const status of ["void", "superseded", "cancelled"]) {
      expect(derive([], { devis: { ...devis, status } }).actions).toEqual([]);
    }
    expect(derive([], { devis: { ...devis, accountingState: "superseded" } }).actions).toEqual([]);
  });
  it("superseded certificates are ignored but a replacement draft is used", () => {
    expect(derive([cert({ status: "superseded" }), cert({ id: 11 })]).actions).toHaveLength(1);
    expect(derive([cert({ status: "superseded" }), cert({ id: 11 })]).actions[0].certificateId).toBe(11);
  });
  it("does not suggest a deposit after it is paid or applied", () => {
    for (const acompteState of ["paid", "applied"]) {
      expect(derive([], { devis: { ...devis, acompteState } }).actions).toEqual([]);
    }
  });
  it("uses invoice workflow for invoice-backed deposits", () => {
    expect(derive([], { devis: { ...devis, acompteState: "invoiced", acompteInvoiceId: 7 } }).actions[0])
      .toMatchObject({ code: "review_deposit_invoice", href: "/projets/9?tab=factures&invoice=7" });
  });
  it("does not mistake legacy contractor-wide certificates for a confirmed deposit absence", () => {
    expect(derive([], { unscopedCertificate: certificate }).actions[0])
      .toMatchObject({ code: "deposit_scope_unknown", tone: "unknown" });
  });
  it("signed quotes never re-enter signing suggestions, even with obsolete blockers", () => {
    const r = { readyToSend: false, blockers: ["Translation missing"] } as any;
    expect(derive([], { readiness: r }).actions.every(a => !a.code.includes("signature") && !a.code.includes("signing"))).toBe(true);
    expect(derive([], { devis: { ...devis, signOffStage: "approved_for_signing", signedPdfStorageKey: "signed.pdf" }, readiness: r })
      .actions[0].code).toBe("restore_signed_stage");
  });
  it("missing readiness is unknown, not an all-clear", () => {
    expect(derive([], { devis: { ...devis, signOffStage: "received" } }).actions[0].tone).toBe("unknown");
  });
  it("respects insurance overrides through the existing readiness rules", () => {
    const d = { ...devis, signOffStage: "approved_for_signing" };
    const readiness = deriveDevisReadiness({ devis: d, translationStatus: "finalised", openContractorChecks: 0,
      openClientChecks: 0, clientContactPresent: true, insurance: { ok: false, reason: "Missing mirror" }, insuranceOverridden: true });
    expect(derive([], { devis: d, readiness }).actions[0].code).toBe("prepare_signature");
  });
  it("an already sent request is waiting, not another send action", () => {
    const d = { ...devis, signOffStage: "sent_to_client", archisignEnvelopeStatus: "sent" };
    expect(derive([], { devis: d, readiness: { signature: "sent" } as any }).actions[0])
      .toMatchObject({ code: "await_signature", actor: "client" });
  });
  it("orders multiple actions consistently with payment evidence first", () => {
    const result = derive([cert({ id: 11, status: "ready" }), cert({ id: 10, status: "sent" }, { pendingEvidence: true })]);
    expect(result.actions.map(a => a.code)).toEqual(["verify_payment", "send_certificate"]);
  });
});
