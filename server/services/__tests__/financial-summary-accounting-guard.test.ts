import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Devis } from "@shared/schema";

vi.mock("../../storage", () => ({
  storage: {
    getProject: vi.fn(),
    getDevisByProject: vi.fn(),
    getInvoicesByProject: vi.fn(),
    getAvenantsByDevis: vi.fn(),
    getCertificatsByProject: vi.fn(),
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
    signOffStage: "received",
    invoicingMode: "mode_a",
  } as unknown as Devis;
}

describe("financial-summary — Contracted accounting guard (Task #232)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStorage.getProject.mockResolvedValue({ id: 1, name: "P", code: "P1" });
    mockedStorage.getInvoicesByProject.mockResolvedValue([]);
    mockedStorage.getCertificatsByProject.mockResolvedValue([]);
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
});
