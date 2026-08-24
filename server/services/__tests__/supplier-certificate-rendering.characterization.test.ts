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
import {
  buildCertificatEmailBody,
  generateCertificatPdf,
} from "../../communications/certificat-generator";
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
      dateIssued: "2026-08-20",
      amountHt: "1000.00",
      tvaAmount: "200.00",
      amountTtc: "1200.00",
      extractedIban: null,
    },
  ]);
  mockedStorage.getTemplateAssetByType.mockResolvedValue(null);
  readiness.mockResolvedValue({
    schemaVersion: "1.0",
    provenance: {
      schemaVersion: "1.0",
      sourceSequence: "42",
      capturedAt: "2026-08-24T10:00:00.000Z",
      contentSha256: "a".repeat(64),
    },
    supplier: {
      id: "supplier-archidoc-2",
      name: "Fournisseur Exemple",
      siret: "12345678901234",
      address1: "2 rue du Fournisseur",
      address2: null,
      postcode: "75011",
      town: "Paris",
      countryCode: "FR",
      email: "paiement@fournisseur.fr",
      phone: null,
      legalIdentityStatus: "verified",
      primaryContact: {
        id: "contact-1",
        name: "Marie Fournisseur",
        jobTitle: "Comptabilité",
        email: "paiement@fournisseur.fr",
        phone: null,
        isPrimary: true,
      },
      banking: {
        accountHolderName: "Fournisseur Exemple",
        iban: "FR7630006000011234567890189",
        bic: "AGRIFRPP",
        bankName: "Banque Exemple",
        bankingStatus: "verified",
        bankingVerifiedAt: "2026-08-23T09:00:00.000Z",
        bankingVerifiedBy: { userId: "user-1", displayName: "Alice" },
        ribDocument: {
          id: "rib-1",
          fileName: "RIB.pdf",
          mimeType: "application/pdf",
          sha256: "b".repeat(64),
          downloadPath:
            "/api/integrations/architrak/v1/suppliers/supplier-archidoc-2/rib/rib-1",
        },
      },
    },
    assignment: {
      id: "assignment-1",
      projectId: "project-archidoc-1",
      supplierId: "supplier-archidoc-2",
      status: "active",
      directPaymentStatus: "eligible",
      validFrom: "2026-01-01",
      validUntil: null,
      notes: null,
    },
  });
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
    expect(html).toContain(
      "Certificat de paiement fournisseur — paiement direct client",
    );
    expect(html).toContain("FAC-SUP-31");
    expect(html).toContain("1 000,00 €");
    expect(html).toContain("1 200,00 €");
    expect(html).not.toContain("Retenue de Garantie");
    expect(html).not.toContain("Prorata");
    expect(html).not.toContain("Financial Summary");
    expect(html).not.toContain("Acompte");
    expect(html).not.toContain("Solde");
    expect(result.fileName).toMatch(
      /^CERT-PAIEMENT-DIRECT-FOURNISSEUR-PSUP-SUP-CP-007-\d{8}\.pdf$/,
    );
    expect(result.supplierPresentation).toMatchObject({
      project: { name: "Projet fournisseur" },
      supplier: {
        name: "Fournisseur Exemple",
        siret: "12345678901234",
      },
      invoices: [
        {
          invoiceId: 31,
          invoiceNumber: "FAC-SUP-31",
          invoiceDate: "2026-08-20",
        },
      ],
      transferRef: expect.any(String),
    });
  });

  it("uses supplier direct-payment wording for the sealed client email", () => {
    const body = buildCertificatEmailBody({
      certificat: {
        certificateTrack: "supplier_direct_payment",
        certificateRef: "SUP-CP-007",
        netToPayHt: "1000.00",
        tvaAmount: "200.00",
        netToPayTtc: "1200.00",
        paymentTransferRef: "PAY-SUP-31",
        issuanceSnapshot: {
          supplierDirectPayment: {
            readiness: {
              supplier: { name: "Fournisseur Exemple" },
            },
            sources: {
              invoices: [{ invoiceNumber: "FAC-SUP-31" }],
            },
            presentation: {
              certificateRef: "SUP-CP-007",
              issueDate: "2026-08-24",
              project: {
                id: 1,
                archidocId: "project-1",
                code: "P-SUP",
                name: "Projet fournisseur",
                clientName: "Maître d'ouvrage",
                clientContactEmail: "client@example.com",
                clientAddress: null,
              },
              supplier: {
                id: "supplier-1",
                name: "Fournisseur Exemple",
              },
              banking: {
                accountHolderName: "Fournisseur Exemple",
                iban: "FR7630006000011234567890189",
              },
              assignment: {
                id: "assignment-1",
                directPaymentStatus: "eligible",
              },
              invoices: [
                {
                  invoiceId: 31,
                  invoiceNumber: "FAC-SUP-31",
                  invoiceDate: "2026-08-20",
                  amountHt: "1000.00",
                  tvaAmount: "200.00",
                  amountTtc: "1200.00",
                },
              ],
              totals: {
                netToPayHt: "1000.00",
                tvaAmount: "200.00",
                netToPayTtc: "1200.00",
              },
              transferRef: "PAY-SUP-31",
            },
            paymentTransferRef: "PAY-SUP-31",
          },
        },
      } as any,
      project: {
        name: "Projet fournisseur",
        code: "P-SUP",
      } as any,
      contractor: {
        name: "Legacy contractor label must not appear",
      } as any,
    });

    expect(body).toContain("supplier direct-payment certificate");
    expect(body).toContain("Fournisseur Exemple");
    expect(body).toContain("FAC-SUP-31");
    expect(body).toContain("PAY-SUP-31");
    expect(body).not.toContain("works carried out by the contractor");
    expect(body).not.toContain("Legacy contractor label");
  });

  it("uses readiness banking rather than mutable contractor banking fields", async () => {
    mockedStorage.getContractor.mockResolvedValue({
      id: 2,
      name: "Fournisseur Exemple",
      archidocPartnerType: "supplier",
      iban: null,
      bic: null,
      address: "Adresse locale obsolète",
    });

    await expect(
      generateCertificatPdf(7, { mode: "preview" }),
    ).resolves.toMatchObject({
      supplierPresentation: {
        banking: {
          iban: "FR7630006000011234567890189",
          bic: "AGRIFRPP",
        },
      },
    });
  });
});