import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import(
    "../../routes/__tests__/helpers/mock-storage"
  );
  return {
    storage: createStorageMock([
      "getCertificat",
      "getCertificatSources",
      "getProject",
      "getInvoice",
      "getDevis",
      "updateCertificat",
      "sealCertificat",
    ]),
  };
});

vi.mock("../../communications/certificat-generator", () => ({
  generateCertificatPdf: vi.fn(),
}));

vi.mock("../certificat-deductions.service", () => ({
  resolveCertificatDeductions: vi.fn(),
}));

vi.mock("../supplier-payment-readiness.service", () => ({
  assertSupplierPaymentReadiness: vi.fn(),
}));

vi.mock("../certificat-from-invoices.service", () => ({
  deriveCertificatFromInvoices: vi.fn(),
  SupplierCertificateSourceError: class SupplierCertificateSourceError extends Error {
    readonly code = "SUPPLIER_CERTIFICATE_SOURCE_SET_INVALID";
  },
}));

vi.mock("../drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../supplier-certificate-rollout.service", () => ({
  isSupplierDirectPaymentAllowedForProject: vi.fn().mockReturnValue(true),
  SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED:
    "SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED",
}));

import { storage } from "../../storage";
import { generateCertificatPdf } from "../../communications/certificat-generator";
import { resolveCertificatDeductions } from "../certificat-deductions.service";
import { assertSupplierPaymentReadiness } from "../supplier-payment-readiness.service";
import { deriveCertificatFromInvoices } from "../certificat-from-invoices.service";
import { sealCertificat } from "../certificat-seal.service";

const mockedStorage = storage as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const generate = generateCertificatPdf as unknown as ReturnType<typeof vi.fn>;
const resolveDeductions =
  resolveCertificatDeductions as unknown as ReturnType<typeof vi.fn>;
const assertReadiness =
  assertSupplierPaymentReadiness as unknown as ReturnType<typeof vi.fn>;
const derive =
  deriveCertificatFromInvoices as unknown as ReturnType<typeof vi.fn>;

const readinessSnapshot = {
  provenance: {
    schemaVersion: "archidoc_supplier_payment_readiness_v1",
    sourceSequence: "9",
    capturedAt: "2026-08-20T10:01:00Z",
    contentSha256: "f".repeat(64),
  },
  supplier: {
    id: "supplier-1",
    partnerType: "supplier",
    name: "Supplier One",
    siret: "12345678901234",
    address1: "1 rue du Test",
    address2: null,
    town: "Paris",
    postcode: "75001",
    countryCode: "FR",
    isActive: true,
    primaryContact: {
      id: "contact-1",
      name: "Supplier Contact",
      jobTitle: null,
      email: "supplier@example.test",
      mobile: null,
    },
    banking: {
      accountHolderName: "Supplier One",
      iban: "FR7630006000011234567890189",
      bic: "AGRIFRPP",
      bankName: null,
      bankingVerificationStatus: "verified",
      bankingVerifiedAt: "2026-08-20T10:00:00Z",
      bankingVerifiedBy: { id: "user-1", displayName: "Architect" },
      bankingVerificationMethod: "manual_rib_review",
      ribDocument: {
        id: "rib-1",
        fileName: "RIB.pdf",
        mimeType: "application/pdf",
        sha256: "c".repeat(64),
        downloadPath:
          "/api/integrations/architrak/v1/suppliers/supplier-1/rib/rib-1",
        updatedAt: "2026-08-20T10:00:00Z",
      },
    },
    updatedAt: "2026-08-20T10:00:00Z",
  },
  assignment: {
    id: "assignment-1",
    projectId: "project-1",
    directPaymentStatus: "eligible",
    validFrom: "2026-01-01",
    validUntil: null,
    reason: null,
    updatedAt: "2026-08-20T10:00:00Z",
  },
};

const supplierCert = {
  id: 90,
  projectId: 1,
  contractorId: 2,
  certificateTrack: "supplier_direct_payment",
  certificateRef: "SUP-CP-90",
  dateIssued: null,
  totalWorksHt: "1000.00",
  pvMvAdjustment: "0.00",
  previousPayments: "0.00",
  retenueGarantie: "0.00",
  cumulativeProrataDeduction: "0.00",
  periodProrataDeduction: "0.00",
  cumulativeAcompteRecoupment: "0.00",
  periodAcompteRecoupment: "0.00",
  tvaRatePercent: "20.00",
  tvaAutoliquidation: false,
  tvaRateSource: "documentary",
  isSolde: false,
  retenueReleased: false,
  retenueReleaseAmount: "0.00",
  retenueReleaseReason: null,
  retenueReleaseDate: null,
  pvOverrideReason: null,
  pvOverrideByUserId: null,
  pvOverrideAt: null,
  netToPayHt: "1000.00",
  tvaAmount: "200.00",
  netToPayTtc: "1200.00",
  acompteDevisId: null,
  pdfStorageKey: null,
  version: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
  mockedStorage.getCertificat.mockResolvedValue(supplierCert);
  mockedStorage.getProject.mockResolvedValue({
    id: 1,
    archidocId: "project-1",
  });
  mockedStorage.getCertificatSources.mockResolvedValue([
    { certificatId: 90, invoiceId: 41, situationId: null },
  ]);
  mockedStorage.getInvoice.mockResolvedValue({
    id: 41,
    devisId: 11,
    dateIssued: "2026-08-20",
    extractedIban: null,
  });
  mockedStorage.getDevis.mockResolvedValue({
    id: 11,
    status: "confirmed",
    acompteInvoiceId: null,
    extractedIban: null,
  });
  assertReadiness.mockResolvedValue(readinessSnapshot);
  derive.mockResolvedValue({
    ok: true,
    derivation: {
      certificateTrack: "supplier_direct_payment",
      contractorId: 2,
      projectId: 1,
      invoices: [
        {
          invoiceId: 41,
          invoiceNumber: "FAC-SUP-41",
          devisId: 11,
          mode: "invoice",
          periodClaimHt: 1000,
          amountHt: "1000.00",
          tvaAmount: "200.00",
          amountTtc: "1200.00",
        },
      ],
      periodClaimHt: 1000,
      totalWorksHt: "1000.00",
      previousPayments: "0.00",
      priorCertificateRef: null,
      supplierDirectPayment: {
        tvaRatePercent: "20.00",
        tvaAmount: "200.00",
        netToPayHt: "1000.00",
        netToPayTtc: "1200.00",
      },
    },
  });
  generate.mockResolvedValue({
    storageKey: "supplier-cert.pdf",
    pdfBuffer: Buffer.from("%PDF"),
    fileName: "supplier-cert.pdf",
    sourceInvoiceIds: [41],
    transferRef: "FAC-SUP-41",
    supplierPresentation: {
      certificateRef: "SUP-90",
      issueDate: "2026-08-24",
      project: {
        id: 1,
        archidocId: "project-1",
        code: "P1",
        name: "Project",
        clientName: "Client",
        clientContactEmail: "client@example.com",
        clientAddress: null,
      },
      supplier: {
        id: "supplier-1",
        name: "Supplier",
        contactName: "Supplier Contact",
        contactEmail: "supplier@example.com",
      },
      banking: {
        accountHolderName: "Supplier",
        iban: "FR7630006000011234567890189",
      },
      assignment: {
        id: "assignment-1",
        directPaymentStatus: "eligible",
      },
      invoices: [
        {
          invoiceId: 41,
          invoiceNumber: "FAC-SUP-41",
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
      transferRef: "FAC-SUP-41",
    },
  });
  mockedStorage.sealCertificat.mockResolvedValue({
    ...supplierCert,
    pdfStorageKey: "supplier-cert.pdf",
  });
});

describe("supplier direct-payment seal", () => {
  it("skips contractor deductions and freezes readiness plus exact invoice evidence", async () => {
    const result = await sealCertificat(90);

    expect(result.alreadySealed).toBe(false);
    expect(resolveDeductions).not.toHaveBeenCalled();
    expect(assertReadiness).toHaveBeenCalledWith({
      contractorId: 2,
      projectId: 1,
      issueDate: "2026-08-28",
      verifyProtectedRib: true,
    });
    expect(assertReadiness).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith([41], {
      allowCertificatId: 90,
      issueDate: "2026-08-28",
      supplierReadinessSnapshot: readinessSnapshot,
    });
    expect(generate).toHaveBeenCalledWith(90, {
      mode: "issue",
      supplierReadinessSnapshot: readinessSnapshot,
    });
    const seal = mockedStorage.sealCertificat.mock.calls[0][1];
    expect(seal.sourceRows).toEqual([
      { certificatId: 90, invoiceId: 41, situationId: null },
    ]);
    expect(seal.supplierDirectPaymentGuard).toMatchObject({
      readiness: readinessSnapshot,
      invoices: [
        {
          invoiceId: 41,
          devisId: 11,
          amountHt: "1000.00",
          tvaAmount: "200.00",
          amountTtc: "1200.00",
          devisStatus: "confirmed",
        },
      ],
    });
    expect(seal.issuanceSnapshot).toMatchObject({
      certificateTrack: "supplier_direct_payment",
      totalWorksHt: "1000.00",
      previousPayments: "0.00",
      retenueGarantie: "0.00",
      netToPayHt: "1000.00",
      tvaAmount: "200.00",
      netToPayTtc: "1200.00",
      sourceInvoiceIds: [41],
      supplierDirectPayment: {
        projectArchidocId: "project-1",
        supplierArchidocId: "supplier-1",
        readiness: readinessSnapshot,
        presentation: expect.objectContaining({
          certificateRef: "SUP-90",
          supplier: expect.objectContaining({ name: "Supplier" }),
          invoices: [
            expect.objectContaining({
              invoiceId: 41,
              invoiceNumber: "FAC-SUP-41",
            }),
          ],
        }),
        sources: {
          invoices: [
            {
              invoiceId: 41,
              invoiceNumber: "FAC-SUP-41",
              invoiceDate: "2026-08-20",
              amountHt: "1000.00",
              tvaAmount: "200.00",
              amountTtc: "1200.00",
            },
          ],
        },
        paymentTransferRef: "FAC-SUP-41",
      },
      pdfFileName: "supplier-cert.pdf",
      pdfStorageKey: "supplier-cert.pdf",
    });
  });

  it("cannot switch to a second handoff after invoice evidence validation", async () => {
    const changedUpstream = structuredClone(readinessSnapshot);
    changedUpstream.supplier.banking!.ribDocument!.id = "rib-changed";
    assertReadiness
      .mockResolvedValueOnce(readinessSnapshot)
      .mockResolvedValueOnce(changedUpstream);

    await sealCertificat(90);

    expect(assertReadiness).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith(
      [41],
      expect.objectContaining({
        supplierReadinessSnapshot: readinessSnapshot,
      }),
    );
    expect(generate).toHaveBeenCalledWith(90, {
      mode: "issue",
      supplierReadinessSnapshot: readinessSnapshot,
    });
    expect(
      mockedStorage.sealCertificat.mock.calls[0][1]
        .supplierDirectPaymentGuard?.readiness,
    ).toBe(readinessSnapshot);
  });

  it("refuses a rendered PDF whose source set drifts from the locked invoices", async () => {
    generate.mockResolvedValue({
      storageKey: "supplier-cert.pdf",
      pdfBuffer: Buffer.from("%PDF"),
      fileName: "supplier-cert.pdf",
      sourceInvoiceIds: [],
      transferRef: "FAC-SUP-41",
      supplierPresentation: {} as any,
    });

    await expect(sealCertificat(90)).rejects.toMatchObject({
      code: "SUPPLIER_CERTIFICATE_SOURCE_SET_INVALID",
    });
    expect(mockedStorage.sealCertificat).not.toHaveBeenCalled();
  });
});