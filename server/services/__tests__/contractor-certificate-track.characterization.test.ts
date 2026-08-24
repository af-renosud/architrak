import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage", () => ({
  storage: {
    getProject: vi.fn(),
    getMarchesByProject: vi.fn(),
    getCertificatsByProjectAndContractor: vi.fn(),
    getDevisByProject: vi.fn(),
    getContractor: vi.fn(),
    getInvoicesByDevis: vi.fn(),
    getCertificat: vi.fn(),
    getDevisByProjectAndContractor: vi.fn(),
    getCertificatSources: vi.fn(),
    findBankingMismatchOverride: vi.fn(),
  },
}));

import { storage } from "../../storage";
import { resolveCertificatDeductions } from "../certificat-deductions.service";
import { evaluateInsuranceMirrorPreloaded } from "../insurance-verdict";
import {
  BankingMismatchError,
  generateCertificatPdf,
} from "../../communications/certificat-generator";

const mocked = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("legacy contractor works certificate boundary", () => {
  it("keeps the contractor retention, prorata, deposit-recoupment, and TVA waterfall", async () => {
    mocked.getProject.mockResolvedValue({ id: 1, prorataPercentage: "2.00" });
    mocked.getMarchesByProject.mockResolvedValue([
      {
        id: 10,
        contractorId: 2,
        retenueGarantiePercent: "5.00",
        hasBankGuarantee: false,
        isProrataManager: false,
        acompteRecoupmentRule: "asap",
        acompteRecoupmentPercent: null,
        acompteRecoupmentThresholdPercent: null,
        totalHt: "10000.00",
        tvaRatePercent: "20.00",
        tvaAutoliquidation: false,
      },
    ]);
    mocked.getCertificatsByProjectAndContractor.mockResolvedValue([]);
    mocked.getDevisByProject.mockResolvedValue([
      {
        id: 20,
        contractorId: 2,
        status: "active",
        signOffStage: "signed",
        acompteState: "paid",
        acompteAmountHt: "1000.00",
      },
    ]);
    mocked.getContractor.mockResolvedValue({
      id: 2,
      archidocPartnerType: "contractor",
      defaultTvaRatePercent: null,
      defaultTvaAutoliquidation: false,
    });
    mocked.getInvoicesByDevis.mockResolvedValue([]);

    const result = await resolveCertificatDeductions({
      projectId: 1,
      contractorId: 2,
      totalWorksHt: "10000.00",
      previousPayments: "0.00",
    });

    expect(result).toMatchObject({
      retenueGarantie: "500.00",
      cumulativeProrataDeduction: "200.00",
      periodProrataDeduction: "200.00",
      cumulativeAcompteRecoupment: "1000.00",
      periodAcompteRecoupment: "1000.00",
      tvaRatePercent: "20.00",
      tvaRateSource: "marche",
      netToPayHt: "8300.00",
      tvaAmount: "1660.00",
      netToPayTtc: "9960.00",
    });
  });

  it("continues to block an explicitly assigned contractor whose insurance is expired", () => {
    const decision = evaluateInsuranceMirrorPreloaded(
      {
        archidocId: "contractor-archidoc-id",
        insuranceStatus: "expired",
      },
      [
        {
          lotNumber: "03",
          contractorId: "contractor-archidoc-id",
        },
      ],
      "03",
    );

    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("expired");
  });

  it("blocks PDF materialisation on an unexplained document/ArchiDoc IBAN mismatch", async () => {
    mocked.getCertificat.mockResolvedValue({
      id: 7,
      projectId: 1,
      contractorId: 2,
      certificateRef: "CP-2026-007",
    });
    mocked.getProject.mockResolvedValue({ id: 1, name: "Projet Exemple" });
    mocked.getContractor.mockResolvedValue({
      id: 2,
      name: "Entreprise Exemple",
      archidocPartnerType: "contractor",
      iban: "FR7630006000011234567890189",
    });
    mocked.getDevisByProjectAndContractor.mockResolvedValue([
      {
        id: 21,
        devisCode: "DEV-21",
        status: "active",
        extractedIban: null,
      },
    ]);
    mocked.getCertificatSources.mockResolvedValue([
      { certificatId: 7, invoiceId: 31, situationId: null },
    ]);
    mocked.getInvoicesByDevis.mockResolvedValue([
      {
        id: 31,
        invoiceNumber: "FAC-31",
        extractedIban: "DE89370400440532013000",
      },
    ]);
    mocked.findBankingMismatchOverride.mockResolvedValue(null);

    const error = await generateCertificatPdf(7).catch((caught) => caught);

    expect(error).toBeInstanceOf(BankingMismatchError);
    expect(error).toMatchObject({
      code: "BANKING_MISMATCH",
      contractorId: 2,
      archidocIban: "FR7630006000011234567890189",
      mismatches: [
        {
          docKind: "invoice",
          docId: 31,
          docCode: "FAC-31",
          docIban: "DE89370400440532013000",
        },
      ],
    });
    expect(mocked.findBankingMismatchOverride).toHaveBeenCalledWith({
      docKind: "invoice",
      docId: 31,
      docIban: "DE89370400440532013000",
      archidocIban: "FR7630006000011234567890189",
    });
  });
});