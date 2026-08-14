import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveCertificatDeductions,
  SoldeConflictError,
  ReleaseRequiresSoldeError,
} from "../certificat-deductions.service";
import { storage } from "../../storage";
import { computeCertificatDeductions } from "@shared/financial-utils";

/**
 * Task #464 — solde certificat + explicit retenue de garantie release.
 * Pins: single-solde precondition, release-requires-solde, the release
 * amount = cumulative retenue added back as a positive line, and the
 * default WITHHELD behaviour.
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
};

function setup(opts: { priorCerts?: unknown[]; marche?: Partial<typeof baseMarche> } = {}) {
  mocked.getProject.mockResolvedValue({ id: 1, prorataPercentage: "0" });
  mocked.getMarchesByProject.mockResolvedValue([{ ...baseMarche, ...opts.marche }]);
  mocked.getCertificatsByProjectAndContractor.mockResolvedValue(opts.priorCerts ?? []);
  mocked.getDevisByProject.mockResolvedValue([]);
  mocked.getContractor.mockResolvedValue({ id: 2, defaultTvaRatePercent: null, defaultTvaAutoliquidation: false });
}

const input = {
  projectId: 1,
  contractorId: 2,
  totalWorksHt: "10000.00",
  previousPayments: "0.00",
};

describe("resolveCertificatDeductions — solde & retenue release (Task #464)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("default: not solde, retenue withheld, no release amount", async () => {
    setup();
    const r = await resolveCertificatDeductions(input);
    expect(r.isSolde).toBe(false);
    expect(r.retenueReleased).toBe(false);
    expect(r.retenueReleaseAmount).toBe("0.00");
    expect(r.retenueGarantie).toBe("500.00");
    expect(r.netToPayHt).toBe("9500.00");
  });

  it("solde WITHOUT release keeps the holdback withheld", async () => {
    setup();
    const r = await resolveCertificatDeductions({ ...input, isSolde: true });
    expect(r.isSolde).toBe(true);
    expect(r.retenueReleased).toBe(false);
    expect(r.retenueReleaseAmount).toBe("0.00");
    expect(r.netToPayHt).toBe("9500.00");
  });

  it("solde WITH release adds the cumulative retenue back as a positive line", async () => {
    setup();
    const r = await resolveCertificatDeductions({ ...input, isSolde: true, releaseRetenue: true });
    expect(r.retenueReleased).toBe(true);
    expect(r.retenueReleaseAmount).toBe("500.00");
    // 10000 − 500 (retenue) + 500 (release) = 10000
    expect(r.netToPayHt).toBe("10000.00");
    expect(r.netToPayTtc).toBe("12000.00");
  });

  it("bank-guarantee contract holds 0 so the release line is 0", async () => {
    setup({ marche: { hasBankGuarantee: true } });
    const r = await resolveCertificatDeductions({ ...input, isSolde: true, releaseRetenue: true });
    expect(r.retenueReleased).toBe(true);
    expect(r.retenueReleaseAmount).toBe("0.00");
    expect(r.netToPayHt).toBe("10000.00");
  });

  it("rejects release on a non-solde certificat", async () => {
    setup();
    await expect(
      resolveCertificatDeductions({ ...input, releaseRetenue: true }),
    ).rejects.toBeInstanceOf(ReleaseRequiresSoldeError);
  });

  it("rejects a second non-superseded solde for the same pair", async () => {
    setup({
      priorCerts: [
        { id: 9, isSolde: true, status: "sent", certificateRef: "CP-2026-003", dateIssued: "2026-01-01", retenueGarantie: "500.00", cumulativeProrataDeduction: "0.00", cumulativeAcompteRecoupment: "0.00" },
      ],
    });
    await expect(
      resolveCertificatDeductions({ ...input, isSolde: true }),
    ).rejects.toBeInstanceOf(SoldeConflictError);
  });

  it("allows a solde when the only prior solde is superseded", async () => {
    setup({
      priorCerts: [
        { id: 9, isSolde: true, status: "superseded", certificateRef: "CP-2026-003", dateIssued: "2026-01-01", retenueGarantie: "500.00", cumulativeProrataDeduction: "0.00", cumulativeAcompteRecoupment: "0.00" },
      ],
    });
    const r = await resolveCertificatDeductions({ ...input, isSolde: true });
    expect(r.isSolde).toBe(true);
  });

  it("allows a solde when the prior solde is the excluded certificat itself (recompute)", async () => {
    setup({
      priorCerts: [
        { id: 42, isSolde: true, status: "draft", certificateRef: "CP-2026-004", dateIssued: null, retenueGarantie: "500.00", cumulativeProrataDeduction: "0.00", cumulativeAcompteRecoupment: "0.00" },
      ],
    });
    const r = await resolveCertificatDeductions({ ...input, isSolde: true, excludeCertificatId: 42 });
    expect(r.isSolde).toBe(true);
  });
});

describe("computeCertificatDeductions — release step (Task #464)", () => {
  const base = {
    totalWorksHt: 10000,
    pvMvAdjustment: 0,
    previousPayments: 8000,
    retenuePercent: 5,
    hasBankGuarantee: false,
    prorataPercent: 0,
    isProrataManager: false,
    priorCumulativeRetenue: 400,
    priorCumulativeProrata: 0,
  };

  it("release ignored when not solde", () => {
    const r = computeCertificatDeductions({ ...base, releaseRetenue: true });
    expect(r.retenueReleaseAmount).toBe(0);
    expect(r.netToPayHt).toBe(1500);
  });

  it("solde release adds cumulative retenue back into net", () => {
    const r = computeCertificatDeductions({ ...base, isSolde: true, releaseRetenue: true });
    expect(r.cumulativeRetenue).toBe(500);
    expect(r.retenueReleaseAmount).toBe(500);
    // 10000 − 500 − 8000 + 500 = 2000
    expect(r.netToPayHt).toBe(2000);
  });

  it("solde without release stays withheld", () => {
    const r = computeCertificatDeductions({ ...base, isSolde: true });
    expect(r.retenueReleaseAmount).toBe(0);
    expect(r.netToPayHt).toBe(1500);
  });
});
