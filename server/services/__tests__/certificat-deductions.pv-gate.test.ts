import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveCertificatDeductions } from "../certificat-deductions.service";
import {
  PvReceptionRequiredError,
  assertPvReceptionForSolde,
  isPvReceptionApproved,
} from "../pv-reception.service";
import { storage } from "../../storage";

/**
 * Task #566 — PV de réception gate for final payment.
 * Pins: a solde certificat is refused unless the marché carries an APPROVED
 * PV with a reception date, or the caller holds a recorded override.
 * Non-solde certificats are never gated.
 */

vi.mock("../../storage", () => ({
  storage: {
    getProject: vi.fn(),
    getMarchesByProject: vi.fn(),
    getCertificatsByProjectAndContractor: vi.fn(),
    getDevisByProject: vi.fn(),
    getContractor: vi.fn(),
  },
}));

const mocked = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;

const baseMarche = {
  id: 1,
  contractorId: 2,
  retenueGarantiePercent: "5.00",
  hasBankGuarantee: false,
  isProrataManager: false,
  acompteRecoupmentRule: "asap",
  acompteRecoupmentPercent: null,
  acompteRecoupmentThresholdPercent: null,
  totalHt: null,
  tvaRatePercent: null,
  tvaAutoliquidation: false,
  pvReceptionStatus: null as string | null,
  receptionDate: null as string | null,
};

function setup(opts: { marche?: Partial<typeof baseMarche> | null } = {}) {
  mocked.getProject.mockResolvedValue({ id: 1, prorataPercentage: "0" });
  mocked.getMarchesByProject.mockResolvedValue(
    opts.marche === null ? [] : [{ ...baseMarche, ...opts.marche }],
  );
  mocked.getCertificatsByProjectAndContractor.mockResolvedValue([]);
  mocked.getDevisByProject.mockResolvedValue([]);
  mocked.getContractor.mockResolvedValue({ id: 2, defaultTvaRatePercent: null, defaultTvaAutoliquidation: false });
}

const input = {
  projectId: 1,
  contractorId: 2,
  totalWorksHt: "10000.00",
  previousPayments: "0.00",
};

describe("resolveCertificatDeductions — PV de réception gate (Task #566)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("non-solde certificats are never gated, even with no PV", async () => {
    setup();
    const r = await resolveCertificatDeductions(input);
    expect(r.isSolde).toBe(false);
  });

  it("rejects a solde when the marché has no PV at all", async () => {
    setup();
    await expect(resolveCertificatDeductions({ ...input, isSolde: true }))
      .rejects.toBeInstanceOf(PvReceptionRequiredError);
  });

  it("rejects a solde when no marché exists for the contractor", async () => {
    setup({ marche: null });
    await expect(resolveCertificatDeductions({ ...input, isSolde: true }))
      .rejects.toBeInstanceOf(PvReceptionRequiredError);
  });

  it("rejects a solde while the PV is still a draft", async () => {
    setup({ marche: { pvReceptionStatus: "draft", receptionDate: "2026-01-15" } });
    await expect(resolveCertificatDeductions({ ...input, isSolde: true }))
      .rejects.toBeInstanceOf(PvReceptionRequiredError);
  });

  it("rejects a solde when the PV is approved but the reception date is missing", async () => {
    setup({ marche: { pvReceptionStatus: "approved", receptionDate: null } });
    await expect(resolveCertificatDeductions({ ...input, isSolde: true }))
      .rejects.toBeInstanceOf(PvReceptionRequiredError);
  });

  it("allows the solde once the PV is approved with a reception date", async () => {
    setup({ marche: { pvReceptionStatus: "approved", receptionDate: "2026-01-15" } });
    const r = await resolveCertificatDeductions({ ...input, isSolde: true, releaseRetenue: true });
    expect(r.isSolde).toBe(true);
    expect(r.retenueReleased).toBe(true);
  });

  it("a recorded override satisfies the gate without an approved PV", async () => {
    setup();
    const r = await resolveCertificatDeductions({ ...input, isSolde: true, pvOverride: true });
    expect(r.isSolde).toBe(true);
  });

  it("the error reports the marché id and PV status for the UI", async () => {
    setup({ marche: { pvReceptionStatus: "draft", receptionDate: "2026-01-15" } });
    const err = await resolveCertificatDeductions({ ...input, isSolde: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PvReceptionRequiredError);
    expect(err.marcheId).toBe(1);
    expect(err.pvStatus).toBe("draft");
  });
});

describe("pv-reception.service pure helpers (Task #566)", () => {
  it("isPvReceptionApproved requires approved status AND a date", () => {
    expect(isPvReceptionApproved(null)).toBe(false);
    expect(isPvReceptionApproved({ id: 1, pvReceptionStatus: "draft", receptionDate: "2026-01-01" })).toBe(false);
    expect(isPvReceptionApproved({ id: 1, pvReceptionStatus: "approved", receptionDate: null })).toBe(false);
    expect(isPvReceptionApproved({ id: 1, pvReceptionStatus: "approved", receptionDate: "2026-01-01" })).toBe(true);
  });

  it("assertPvReceptionForSolde passes on override regardless of PV state", () => {
    expect(() => assertPvReceptionForSolde(null, true)).not.toThrow();
    expect(() => assertPvReceptionForSolde(null, false)).toThrow(PvReceptionRequiredError);
  });
});
