import { beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "../../storage";
import {
  resolveCertificatDeductions,
  resolveCertificatDeductionsWithExplanation,
} from "../certificat-deductions.service";

vi.mock("../../storage", () => ({
  storage: {
    getProject: vi.fn(),
    getMarchesByProject: vi.fn(),
    getCertificatsByProjectAndContractor: vi.fn(),
    getDevisByProject: vi.fn(),
  },
}));

const mocked = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;

const configuredMarche = {
  id: 10,
  contractorId: 2,
  retenueGarantiePercent: "5.00",
  hasBankGuarantee: false,
  isProrataManager: false,
  acompteRecoupmentRule: "asap",
  acompteRecoupmentPercent: null,
  acompteRecoupmentThresholdPercent: null,
  totalHt: "10000.00",
  pvReceptionStatus: "approved",
  receptionDate: "2026-01-15",
};

const baseInput = {
  projectId: 1,
  contractorId: 2,
  totalWorksHt: "4600.00",
  resolvedTvaDecision: {
    ratePercent: 20,
    autoliquidation: false,
    source: "marche" as const,
  },
};

function setup(options: {
  marche?: Partial<typeof configuredMarche> | null;
  prorataPercentage?: string;
  priorCerts?: unknown[];
} = {}) {
  mocked.getProject.mockResolvedValue({
    id: 1,
    prorataPercentage: options.prorataPercentage ?? "0.00",
  });
  mocked.getMarchesByProject.mockResolvedValue(
    options.marche === null
      ? []
      : [{ ...configuredMarche, ...options.marche }],
  );
  mocked.getCertificatsByProjectAndContractor.mockResolvedValue(
    options.priorCerts ?? [],
  );
  mocked.getDevisByProject.mockResolvedValue([]);
}

describe("certificat deduction preview explanation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("explains the standard 5% retention and keeps authoritative TVA totals", async () => {
    const { deductions, explanation } =
      await resolveCertificatDeductionsWithExplanation(baseInput);

    expect(explanation).toEqual({
      grossCumulativeHt: "4600.00",
      pvMvAdjustment: "0.00",
      previousPayments: "0.00",
      retention: {
        source: "marche",
        ratePercent: "5.00",
        rateSource: "marche",
        baseHt: "4600.00",
      },
    });
    expect(deductions).toMatchObject({
      retenueGarantie: "230.00",
      netToPayHt: "4370.00",
      tvaAmount: "874.00",
      netToPayTtc: "5244.00",
    });
  });

  it("gives overrides precedence over a bank guarantee, including explicit zero", async () => {
    setup({ marche: { hasBankGuarantee: true } });

    const zero = await resolveCertificatDeductionsWithExplanation({
      ...baseInput,
      retenueOverride: "0.00",
    });
    expect(zero.explanation.retention.source).toBe("override");
    expect(zero.deductions.retenueGarantie).toBe("0.00");

    const custom = await resolveCertificatDeductionsWithExplanation({
      ...baseInput,
      retenueOverride: "123.45",
    });
    expect(custom.explanation.retention).toMatchObject({
      source: "override",
      ratePercent: "5.00",
      rateSource: "marche",
    });
    expect(custom.deductions.retenueGarantie).toBe("123.45");
  });

  it("distinguishes configured, default, and bank-guarantee rules", async () => {
    setup({ marche: null });
    const defaulted = await resolveCertificatDeductionsWithExplanation(baseInput);
    expect(defaulted.explanation.retention).toEqual({
      source: "default",
      ratePercent: "5.00",
      rateSource: "default",
      baseHt: "4600.00",
    });

    setup({ marche: { retenueGarantiePercent: "7.50" } });
    const configured =
      await resolveCertificatDeductionsWithExplanation(baseInput);
    expect(configured.explanation.retention).toMatchObject({
      source: "marche",
      ratePercent: "7.50",
      rateSource: "marche",
    });

    setup({
      marche: {
        retenueGarantiePercent: "7.50",
        hasBankGuarantee: true,
      },
    });
    const guaranteed =
      await resolveCertificatDeductionsWithExplanation(baseInput);
    expect(guaranteed.explanation.retention).toMatchObject({
      source: "bank_guarantee",
      ratePercent: "7.50",
      rateSource: "marche",
    });
    expect(guaranteed.deductions.retenueGarantie).toBe("0.00");
  });

  it("reports the exact PV/MV base and previous payments used with other deductions", async () => {
    setup({ prorataPercentage: "2.00" });
    const result = await resolveCertificatDeductionsWithExplanation({
      ...baseInput,
      pvMvAdjustment: "400.00",
      previousPayments: "1000.00",
    });

    expect(result.explanation).toMatchObject({
      grossCumulativeHt: "5000.00",
      pvMvAdjustment: "400.00",
      previousPayments: "1000.00",
      retention: { baseHt: "5000.00" },
    });
    expect(result.deductions).toMatchObject({
      retenueGarantie: "250.00",
      cumulativeProrataDeduction: "100.00",
      netToPayHt: "3650.00",
      tvaAmount: "730.00",
      netToPayTtc: "4380.00",
    });
  });

  it("keeps release and autoliquidation math unchanged", async () => {
    const released = await resolveCertificatDeductionsWithExplanation({
      ...baseInput,
      isSolde: true,
      releaseRetenue: true,
      resolvedTvaDecision: {
        ratePercent: 0,
        autoliquidation: true,
        source: "autoliquidation",
      },
    });

    expect(released.deductions).toMatchObject({
      retenueGarantie: "230.00",
      retenueReleased: true,
      retenueReleaseAmount: "230.00",
      netToPayHt: "4600.00",
      tvaAmount: "0.00",
      netToPayTtc: "4600.00",
    });
    expect(released.explanation.retention.source).toBe("marche");
  });

  it("returns exactly the same automatic deductions to preview and persistence callers", async () => {
    const preview = await resolveCertificatDeductionsWithExplanation(baseInput);
    const create = await resolveCertificatDeductions(baseInput);
    expect(preview.deductions).toEqual(create);
    expect(create).not.toHaveProperty("explanation");
  });
});