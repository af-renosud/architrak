import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage", () => ({
  storage: {
    getCertificat: vi.fn(),
    getProject: vi.fn(),
    getContractor: vi.fn(),
    getDevisByProjectAndContractor: vi.fn(),
    getCertificatSources: vi.fn(),
    getInvoicesByDevis: vi.fn(),
    findBankingMismatchOverride: vi.fn(),
    getTemplateAssetByType: vi.fn(),
    getLot: vi.fn(),
    getMarchesByProject: vi.fn(),
  },
}));

vi.mock("../supplier-payment-readiness.service", () => ({
  assertSupplierPaymentReadiness: vi.fn(),
}));

vi.mock("../financial-summary.service", () => ({
  getProjectFinancialSummary: vi.fn(),
}));

vi.mock("../docraptor", () => ({
  convertHtmlToPdf: vi.fn(),
}));

vi.mock("../../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(),
  uploadDocument: vi.fn(),
}));

import { storage } from "../../storage";
import { generateCertificatPdf } from "../../communications/certificat-generator";
import { assertSupplierPaymentReadiness } from "../supplier-payment-readiness.service";
import { getProjectFinancialSummary } from "../financial-summary.service";
import { convertHtmlToPdf } from "../docraptor";

const mockedStorage = storage as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const readiness =
  assertSupplierPaymentReadiness as unknown as ReturnType<typeof vi.fn>;
const financialSummary =
  getProjectFinancialSummary as unknown as ReturnType<typeof vi.fn>;
const convert = convertHtmlToPdf as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedStorage.getCertificat.mockResolvedValue({
    id: 7,
    projectId: 1,
    contractorId: 2,
    certificateTrack: "supplier_direct_payment",
    certificateRef: "SUP-CP-007",
    dateIssued: "2026-08-24",
    netToPayHt: "1000.00",
    tvaAmount: "200.00",
    netToPayTtc: "1200.00",
    tvaRatePercent: "20.00",
    tvaAutoliquidation: false,
    acompteDevisId: null,
  });
  mockedStorage.getProject.mockResolvedValue({
    id: 1,
    code: "P-SUP",
    name: "Projet fournisseur",
    clientName: "Maître d'ouvrage",
    clientAddress: "1 rue du Client",
  });
  mockedStorage.getContractor.mockResolvedValue({
    id: 2,
    name: "Fournisseur Exemple",
    archidocPartnerType: "supplier",
    iban: "FR7630006000011234567890189",
    bic: "AGRIFRPP",
    accountHolderName: "Fournisseur Exemple",
    bankName: "Banque Exemple",
    address: "2 rue du Fournisseur",
    postcode: "75011",
    town: "Paris",
  });
  mockedStorage.getDevisByProjectAndContractor.mockResolvedValue([
    {
      id: 11,
      projectId: 1,
      contractorId: 2,
      devisCode: "DEV-SUP-11",
      descriptionFr: "Fournitures",
      amountHt: "1000.00",
      amountTtc: "1200.00",
      status: "confirmed",
      lotId: 99,
      extractedIban: null,
    },
  ]);
  mockedStorage.getCertificatSources.mockResolvedValue([
    { certificatId: 7, invoiceId: 31, situationId: null },
  ]);
  mockedStorage.getInvoicesByDevis.mockResolvedValue([
    {
      id: 31,
      devisId: 11,
      invoiceNumber: "FAC-SUP-31",
      amountHt: "1000.00",
      tvaAmount: "200.00",
      amountTtc: "1200.00",
      extractedIban: null,
    },
  ]);
  mockedStorage.getTemplateAssetByType.mockResolvedValue(null);
  readiness.mockResolvedValue({});
  convert.mockResolvedValue(Buffer.from("%PDF supplier"));
});

describe("supplier certificate rendering boundary", () => {
  it("renders selected invoices without entering contractor financial logic", async () => {
    const result = await generateCertificatPdf(7, { mode: "preview" });

    expect(result.sourceInvoiceIds).toEqual([31]);
    expect(result.storageKey).toBeNull();
    expect(financialSummary).not.toHaveBeenCalled();
    expect(mockedStorage.getMarchesByProject).not.toHaveBeenCalled();
    expect(mockedStorage.getLot).not.toHaveBeenCalled();
    const html = convert.mock.calls[0][0] as string;
    expect(html).toContain("Certificat de paiement direct fournisseur");
    expect(html).toContain("FAC-SUP-31");
    expect(html).toContain("1 000,00 €");
    expect(html).toContain("1 200,00 €");
    expect(html).not.toContain("Retenue de Garantie");
    expect(html).not.toContain("Prorata");
    expect(html).not.toContain("Financial Summary");
    expect(html).not.toContain("Acompte");
    expect(html).not.toContain("Solde");
  });
});