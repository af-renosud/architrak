import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveCertificatDeductions } from "../certificat-deductions.service";
import { storage } from "../../storage";

/**
 * Task #463 — TVA regime resolution pins for the server-authoritative
 * deductions resolver: marché rate → contractor default → standard 20%,
 * autoliquidation forcing 0% (art. 283 CGI) and beating any override.
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

const mocked = storage as unknown as {
  getProject: ReturnType<typeof vi.fn>;
  getMarchesByProject: ReturnType<typeof vi.fn>;
  getCertificatsByProjectAndContractor: ReturnType<typeof vi.fn>;
  getDevisByProject: ReturnType<typeof vi.fn>;
  getContractor: ReturnType<typeof vi.fn>;
};

const baseMarche = {
  id: 1,
  contractorId: 2,
  retenueGarantiePercent: "0.00",
  hasBankGuarantee: false,
  isProrataManager: false,
  acompteRecoupmentRule: "asap",
  acompteRecoupmentPercent: null,
  acompteRecoupmentThresholdPercent: null,
  totalHt: null,
  tvaRatePercent: null,
  tvaAutoliquidation: false,
};

function setup(opts: {
  marche?: Partial<typeof baseMarche> | null;
  contractor?: { defaultTvaRatePercent: string | null; defaultTvaAutoliquidation: boolean } | null;
}) {
  mocked.getProject.mockResolvedValue({ id: 1, prorataPercentage: "0" });
  mocked.getMarchesByProject.mockResolvedValue(
    opts.marche === null ? [] : [{ ...baseMarche, ...opts.marche }],
  );
  mocked.getCertificatsByProjectAndContractor.mockResolvedValue([]);
  mocked.getDevisByProject.mockResolvedValue([]);
  mocked.getContractor.mockResolvedValue(
    opts.contractor === null
      ? undefined
      : { id: 2, ...(opts.contractor ?? { defaultTvaRatePercent: null, defaultTvaAutoliquidation: false }) },
  );
}

const input = {
  projectId: 1,
  contractorId: 2,
  totalWorksHt: "1000.00",
  previousPayments: "0.00",
};

describe("resolveCertificatDeductions — TVA regime (Task #463)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to 20% with no marché regime and no contractor default", async () => {
    setup({ marche: {}, contractor: null });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("20.00");
    expect(r.tvaAutoliquidation).toBe(false);
    expect(r.tvaAmount).toBe("200.00");
    expect(r.netToPayTtc).toBe("1200.00");
  });

  it.each([
    ["10.00", "100.00", "1100.00"],
    ["5.50", "55.00", "1055.00"],
    ["8.50", "85.00", "1085.00"],
  ])("applies the marché rate %s", async (rate, tva, ttc) => {
    setup({ marche: { tvaRatePercent: rate } });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe(rate);
    expect(r.tvaAmount).toBe(tva);
    expect(r.netToPayTtc).toBe(ttc);
  });

  it("falls back to the contractor default rate when the marché has no regime", async () => {
    setup({ marche: {}, contractor: { defaultTvaRatePercent: "10.00", defaultTvaAutoliquidation: false } });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("10.00");
    expect(r.tvaAmount).toBe("100.00");
  });

  it("marché autoliquidation forces 0% and sets the flag", async () => {
    setup({ marche: { tvaAutoliquidation: true } });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaAutoliquidation).toBe(true);
    expect(r.tvaRatePercent).toBe("0.00");
    expect(r.tvaAmount).toBe("0.00");
    expect(r.netToPayTtc).toBe("1000.00");
  });

  it("contractor default autoliquidation applies when the marché has no explicit regime", async () => {
    setup({ marche: {}, contractor: { defaultTvaRatePercent: null, defaultTvaAutoliquidation: true } });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaAutoliquidation).toBe(true);
    expect(r.tvaRatePercent).toBe("0.00");
  });

  it("an explicit marché rate opts OUT of a contractor autoliquidation default", async () => {
    setup({ marche: { tvaRatePercent: "20.00" }, contractor: { defaultTvaRatePercent: null, defaultTvaAutoliquidation: true } });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaAutoliquidation).toBe(false);
    expect(r.tvaRatePercent).toBe("20.00");
  });

  it("a draft override beats the marché/contractor rate", async () => {
    setup({ marche: { tvaRatePercent: "20.00" } });
    const r = await resolveCertificatDeductions({ ...input, tvaRateOverride: "5.50" });
    expect(r.tvaRatePercent).toBe("5.50");
    expect(r.tvaAmount).toBe("55.00");
  });

  it("autoliquidation ignores any override (rate is a legal consequence)", async () => {
    setup({ marche: { tvaAutoliquidation: true } });
    const r = await resolveCertificatDeductions({ ...input, tvaRateOverride: "20.00" });
    expect(r.tvaAutoliquidation).toBe(true);
    expect(r.tvaRatePercent).toBe("0.00");
    expect(r.tvaAmount).toBe("0.00");
  });

  it("no marché at all: contractor default, then 20%", async () => {
    setup({ marche: null, contractor: { defaultTvaRatePercent: "5.50", defaultTvaAutoliquidation: false } });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("5.50");
    setup({ marche: null, contractor: null });
    const r2 = await resolveCertificatDeductions(input);
    expect(r2.tvaRatePercent).toBe("20.00");
  });
});