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
    getInvoicesByDevis: vi.fn(),
    getContractor: vi.fn(),
  },
}));

const mocked = storage as unknown as {
  getProject: ReturnType<typeof vi.fn>;
  getMarchesByProject: ReturnType<typeof vi.fn>;
  getCertificatsByProjectAndContractor: ReturnType<typeof vi.fn>;
  getDevisByProject: ReturnType<typeof vi.fn>;
  getInvoicesByDevis: ReturnType<typeof vi.fn>;
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
  mocked.getInvoicesByDevis.mockResolvedValue([]);
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

/**
 * Task #479 — documentary effective rate: mixed-rate invoices (10% + 20%)
 * drive the applied TVA rate via (ΣTTC − ΣHT) / ΣHT over the contractor's
 * non-void devis' invoices. Precedence: autoliquidation → override →
 * documentary → marché → contractor → 20%.
 */
describe("resolveCertificatDeductions — documentary TVA rate (Task #479)", () => {
  beforeEach(() => vi.clearAllMocks());

  const devisRow = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    contractorId: 2,
    status: "confirmed",
    signOffStage: "signed",
    acompteState: "none",
    acompteAmountHt: null,
    ...over,
  });

  function setupWithInvoices(invoicesByDevis: Record<number, Array<{ amountHt: string; amountTtc: string }>>, opts: Parameters<typeof setup>[0] = { marche: {} }, devisRows?: unknown[]) {
    setup(opts);
    const rows = devisRows ?? Object.keys(invoicesByDevis).map((id) => devisRow(Number(id)));
    mocked.getDevisByProject.mockResolvedValue(rows);
    mocked.getInvoicesByDevis.mockImplementation(async (id: number) => invoicesByDevis[id] ?? []);
  }

  it("mixed 10%/20% invoices yield the blended effective rate", async () => {
    // 1000 HT @10% (1100 TTC) + 1000 HT @20% (1200 TTC) → 15% effective.
    setupWithInvoices({ 7: [
      { amountHt: "1000.00", amountTtc: "1100.00" },
      { amountHt: "1000.00", amountTtc: "1200.00" },
    ] });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("15.00");
    expect(r.tvaRateSource).toBe("documentary");
    expect(r.tvaAmount).toBe("150.00");
    expect(r.netToPayTtc).toBe("1150.00");
  });

  it("documentary rate beats the marché/contractor configured rate", async () => {
    setupWithInvoices(
      { 7: [{ amountHt: "1000.00", amountTtc: "1100.00" }] },
      { marche: { tvaRatePercent: "20.00" }, contractor: { defaultTvaRatePercent: "20.00", defaultTvaAutoliquidation: false } },
    );
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("10.00");
    expect(r.tvaRateSource).toBe("documentary");
  });

  it("an architect draft override still beats the documentary rate", async () => {
    setupWithInvoices({ 7: [{ amountHt: "1000.00", amountTtc: "1100.00" }] });
    const r = await resolveCertificatDeductions({ ...input, tvaRateOverride: "5.50" });
    expect(r.tvaRatePercent).toBe("5.50");
    expect(r.tvaRateSource).toBe("override");
  });

  it("autoliquidation ignores documentary evidence (rate is legally 0)", async () => {
    setupWithInvoices({ 7: [{ amountHt: "1000.00", amountTtc: "1200.00" }] }, { marche: { tvaAutoliquidation: true } });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("0.00");
    expect(r.tvaRateSource).toBe("autoliquidation");
    expect(mocked.getInvoicesByDevis).not.toHaveBeenCalled();
  });

  it("void devis' invoices are excluded from the documentary base", async () => {
    setupWithInvoices(
      { 7: [{ amountHt: "1000.00", amountTtc: "1100.00" }], 8: [{ amountHt: "1000.00", amountTtc: "1300.00" }] },
      { marche: {} },
      [devisRow(7), devisRow(8, { status: "void" })],
    );
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("10.00");
  });

  it("another contractor's devis never feed the documentary base", async () => {
    setupWithInvoices(
      { 7: [{ amountHt: "1000.00", amountTtc: "1100.00" }], 9: [{ amountHt: "1000.00", amountTtc: "1200.00" }] },
      { marche: {} },
      [devisRow(7), devisRow(9, { contractorId: 3 })],
    );
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("10.00");
  });

  it("no invoices → falls back to the marché rate with provenance", async () => {
    setupWithInvoices({}, { marche: { tvaRatePercent: "10.00" } }, [devisRow(7)]);
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("10.00");
    expect(r.tvaRateSource).toBe("marche");
  });

  it("implausible documentary rate (>30%) is rejected → configured fallback", async () => {
    setupWithInvoices(
      { 7: [{ amountHt: "100.00", amountTtc: "200.00" }] },
      { marche: {}, contractor: { defaultTvaRatePercent: "20.00", defaultTvaAutoliquidation: false } },
    );
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("20.00");
    expect(r.tvaRateSource).toBe("contractor");
  });

  it("TTC below HT (bad data) is rejected as documentary evidence", async () => {
    setupWithInvoices({ 7: [{ amountHt: "1000.00", amountTtc: "900.00" }] });
    const r = await resolveCertificatDeductions(input);
    expect(r.tvaRatePercent).toBe("20.00");
    expect(r.tvaRateSource).toBe("default");
  });

  it("provenance is reported for every non-documentary source", async () => {
    setup({ marche: {}, contractor: null });
    expect((await resolveCertificatDeductions(input)).tvaRateSource).toBe("default");
    setup({ marche: { tvaRatePercent: "10.00" } });
    expect((await resolveCertificatDeductions(input)).tvaRateSource).toBe("marche");
    setup({ marche: {}, contractor: { defaultTvaRatePercent: "10.00", defaultTvaAutoliquidation: false } });
    expect((await resolveCertificatDeductions(input)).tvaRateSource).toBe("contractor");
  });
});