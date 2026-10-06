import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Devis } from "@shared/schema";

vi.mock("../../storage", () => ({
  storage: {
    getProject: vi.fn(),
    getDevisByProject: vi.fn(),
    getInvoicesByProject: vi.fn(),
    getAvenantsByDevis: vi.fn(),
    getCertificatsByProject: vi.fn(),
    getInvoiceAcompteApplicationsByProject: vi.fn(),
  },
}));

import { getProjectFinancialSummary } from "../financial-summary.service";
import { storage } from "../../storage";

const mockedStorage = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;

function devis(id: number, amountHt: string, accountingState: string, status = "approved"): Devis {
  return {
    id,
    projectId: 1,
    contractorId: 1,
    devisCode: `DEV-${id}`,
    descriptionFr: `Travaux ${id}`,
    descriptionUk: null,
    amountHt,
    amountTtc: amountHt,
    status,
    accountingState,
    signOffStage: "client_signed_off",
    invoicingMode: "mode_a",
  } as unknown as Devis;
}

describe("financial-summary — Contracted accounting guard (Task #232)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStorage.getProject.mockResolvedValue({ id: 1, name: "P", code: "P1" });
    mockedStorage.getInvoicesByProject.mockResolvedValue([]);
    mockedStorage.getCertificatsByProject.mockResolvedValue([]);
    mockedStorage.getInvoiceAcompteApplicationsByProject.mockResolvedValue([]);
    mockedStorage.getAvenantsByDevis.mockResolvedValue([]);
  });

  it("counts only active devis toward Contracted; excludes provisional and superseded", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([
      devis(1, "100.00", "active"),
      devis(2, "200.00", "provisional"),
      devis(3, "400.00", "superseded"),
    ]);

    const result = await getProjectFinancialSummary(1);
    expect(result.success).toBe(true);
    if (!("totalContractedHt" in result.data)) throw new Error("unreachable");
    // Only devis #1 (active) contributes.
    expect(result.data.totalContractedHt).toBe(100);
    // The full per-devis list is still returned for the UI.
    expect(result.data.devis).toHaveLength(3);
  });

  it("still excludes void devis even when accountingState is active", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([
      devis(1, "100.00", "active"),
      devis(2, "50.00", "active", "void"),
    ]);

    const result = await getProjectFinancialSummary(1);
    if (!("totalContractedHt" in result.data)) throw new Error("unreachable");
    expect(result.data.totalContractedHt).toBe(100);
  });

  it("separates Massey unsigned value and retains its financial evidence", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([
      { ...devis(34, "63340.00", "active", "draft"), amountTtc: "69674.00", archisignEnvelopeStatus: "signed" },
      { ...devis(35, "32405.00", "active", "draft"), amountTtc: "34187.28", signOffStage: "approved_for_signing" },
    ]);
    mockedStorage.getInvoicesByProject.mockResolvedValue([{ devisId:35, amountHt:"100.00", amountTtc:"105.50" }]);
    const result = await getProjectFinancialSummary(1);
    if (!("totalContractedHt" in result.data)) throw new Error("unreachable");
    expect(result.data).toMatchObject({
      totalContractedHt:63340, totalContractedTtc:69674,
      totalPendingHt:32405, totalPendingTtc:34187.28,
      totalCertifiedHt:0, totalResteARealiser:63340,
      totalExcludedCertifiedHt:100, totalExcludedCertifiedTtc:105.5,
    });
    expect(result.data.financialExceptions).toHaveLength(1);
    expect(result.data.devis[1]).toMatchObject({ commitmentEligible:false, commitmentStatus:"unsigned", certifiedHt:100 });
  });

  it("keeps approved variations with the signed parent only", async () => {
    mockedStorage.getDevisByProject.mockResolvedValue([
      devis(1,"100.00","active"),
      {...devis(2,"200.00","active"),signOffStage:"sent_for_signature"},
    ]);
    mockedStorage.getAvenantsByDevis.mockResolvedValue([
      {status:"approved",type:"pv",amountHt:"10.00",amountTtc:"10.00"},
      {status:"draft",type:"pv",amountHt:"90.00",amountTtc:"90.00"},
    ]);
    const result = await getProjectFinancialSummary(1);
    expect(result.data).toMatchObject({totalContractedHt:110,totalPendingHt:210});
  });
});
