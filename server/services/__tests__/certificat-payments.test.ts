import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  logPayment,
  correctPayment,
  removePayment,
  reconcilePayments,
  PaymentsLockedError,
  CertificatSupersededPaymentError,
  CertificatDraftPaymentError,
  PaymentNotFoundError,
} from "../certificat-payments.service";
import { computeCertificatPaymentState } from "@shared/financial-utils";
import { storage } from "../../storage";
import type { Certificat } from "@shared/schema";

/**
 * Task #465 — unit pins for the pure reconciliation math and the
 * outcome→typed-error mapping. The atomic transactional invariants (row
 * lock, lock re-check, audits, conditional flip) are pinned against the
 * real DB in server/__tests__/certificat-payments.integration.test.ts.
 */

vi.mock("../../storage", () => ({
  storage: {
    createCertificatPaymentAtomic: vi.fn(),
    updateCertificatPaymentAtomic: vi.fn(),
    deleteCertificatPaymentAtomic: vi.fn(),
  },
}));

const mocked = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
const cert = { id: 7, certificateRef: "CP-2026-005", status: "sent", netToPayTtc: "1200.00" } as unknown as Certificat;

describe("computeCertificatPaymentState", () => {
  it("no payments: nothing paid, not fullyPaid", () => {
    expect(computeCertificatPaymentState(1200, [])).toEqual({ paidToDate: 0, outstanding: 1200, fullyPaid: false, overpaid: false });
  });
  it("partial payments accumulate", () => {
    expect(computeCertificatPaymentState(1200, [500, 300.5])).toEqual({ paidToDate: 800.5, outstanding: 399.5, fullyPaid: false, overpaid: false });
  });
  it("exact coverage flips fullyPaid (roundCurrency compare)", () => {
    const s = computeCertificatPaymentState(1200, [1199.995, 0.004]);
    expect(s.fullyPaid).toBe(true);
    expect(s.overpaid).toBe(false);
    expect(s.outstanding).toBe(0);
  });
  it("over-payment flags overpaid but stays fullyPaid, outstanding clamps to 0", () => {
    expect(computeCertificatPaymentState(1200, [1300])).toEqual({ paidToDate: 1300, outstanding: 0, fullyPaid: true, overpaid: true });
  });
  it("reconcilePayments is status-free math (grandfathered paid cert with no rows)", () => {
    const s = reconcilePayments({ ...cert, status: "paid" } as Certificat, []);
    expect(s.fullyPaid).toBe(false);
    expect(s.paidToDate).toBe(0);
  });
});

describe("outcome → typed error mapping", () => {
  beforeEach(() => vi.clearAllMocks());
  const entry = { datePaid: "2026-08-14", amount: "10.00", method: "virement" as const };

  it("locked → PaymentsLockedError on create/correct/remove", async () => {
    const locked = { outcome: "locked", cert };
    mocked.createCertificatPaymentAtomic.mockResolvedValue(locked);
    mocked.updateCertificatPaymentAtomic.mockResolvedValue(locked);
    mocked.deleteCertificatPaymentAtomic.mockResolvedValue(locked);
    await expect(logPayment(7, entry)).rejects.toBeInstanceOf(PaymentsLockedError);
    await expect(correctPayment(1, { amount: "1.00" })).rejects.toBeInstanceOf(PaymentsLockedError);
    await expect(removePayment(1)).rejects.toBeInstanceOf(PaymentsLockedError);
  });

  it("superseded → CertificatSupersededPaymentError", async () => {
    mocked.createCertificatPaymentAtomic.mockResolvedValue({ outcome: "superseded", cert });
    await expect(logPayment(7, entry)).rejects.toBeInstanceOf(CertificatSupersededPaymentError);
  });

  it("draft → CertificatDraftPaymentError", async () => {
    mocked.createCertificatPaymentAtomic.mockResolvedValue({ outcome: "draft", cert });
    await expect(logPayment(7, entry)).rejects.toBeInstanceOf(CertificatDraftPaymentError);
  });

  it("not_found → PaymentNotFoundError", async () => {
    mocked.deleteCertificatPaymentAtomic.mockResolvedValue({ outcome: "not_found" });
    await expect(removePayment(999)).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it("ok passes through payment + state and forwards changedBy", async () => {
    const payment = { id: 2, certificatId: 7, amount: "10.00" };
    const state = { paidToDate: 10, outstanding: 1190, fullyPaid: false, overpaid: false };
    mocked.updateCertificatPaymentAtomic.mockResolvedValue({ outcome: "ok", cert, payment, state });
    const res = await correctPayment(2, { amount: "10.00" }, "alice");
    expect(res).toEqual({ payment, state });
    expect(mocked.updateCertificatPaymentAtomic).toHaveBeenCalledWith(2, { amount: "10.00" }, "alice");
  });
});
