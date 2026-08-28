import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Certificat } from "@shared/schema";

vi.mock("../../storage", () => ({
  storage: {
    getCertificatSources: vi.fn(),
  },
}));
vi.mock("../supplier-payment-readiness.service", () => ({
  assertSupplierPaymentReadiness: vi.fn(),
}));
vi.mock("../certificat-from-invoices.service", () => ({
  deriveCertificatFromInvoices: vi.fn(),
}));

import { storage } from "../../storage";
import { deriveCertificatFromInvoices } from "../certificat-from-invoices.service";
import { assertSupplierPaymentReadiness } from "../supplier-payment-readiness.service";
import {
  assertSupplierCertificateDispatchValid,
  SupplierCertificateDispatchError,
} from "../supplier-certificate-dispatch.service";

const getSources = vi.mocked(storage.getCertificatSources);
const derive = vi.mocked(deriveCertificatFromInvoices);
const assertReadiness = vi.mocked(assertSupplierPaymentReadiness);

const currentReadiness = {
  supplier: { id: "supplier-1" },
  assignment: { projectId: "project-1" },
  provenance: { contentSha256: "a".repeat(64) },
};

const supplierCert = {
  id: 7,
  projectId: 1,
  contractorId: 2,
  certificateTrack: "supplier_direct_payment",
  dateIssued: "2026-08-24",
  pdfStorageKey: "projects/1/cert.pdf",
  totalWorksHt: "100.00",
  netToPayHt: "100.00",
  tvaAmount: "20.00",
  netToPayTtc: "120.00",
  issuanceSnapshot: {
    dateIssued: "2026-08-24",
    supplierDirectPayment: {
      supplierArchidocId: "supplier-1",
      projectArchidocId: "project-1",
      readiness: {
        provenance: { contentSha256: "a".repeat(64) },
      },
    },
  },
} as Certificat;

const successfulDerivation = {
  ok: true as const,
  derivation: {
    certificateTrack: "supplier_direct_payment" as const,
    totalWorksHt: "100.00",
    supplierDirectPayment: {
      netToPayHt: "100.00",
      tvaAmount: "20.00",
      netToPayTtc: "120.00",
    },
  },
};

describe("supplier certificate dispatch revalidation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    assertReadiness.mockResolvedValue(currentReadiness as never);
    getSources.mockResolvedValue([
      { invoiceId: 31, situationId: null },
    ] as never);
    derive.mockResolvedValue(successfulDerivation as never);
  });

  it("bypasses only the rollout gate for an already sealed supplier", async () => {
    await expect(
      assertSupplierCertificateDispatchValid(supplierCert),
    ).resolves.toBeUndefined();
    expect(assertReadiness).toHaveBeenCalledWith({
      contractorId: 2,
      projectId: 1,
      issueDate: "2026-08-24",
    });
    expect(derive).toHaveBeenCalledWith([31], {
      allowCertificatId: 7,
      skipSupplierRolloutGate: true,
      issueDate: "2026-08-24",
      supplierReadinessSnapshot: currentReadiness,
    });
  });

  it("does not apply supplier checks to contractor certificates", async () => {
    await assertSupplierCertificateDispatchValid({
      ...supplierCert,
      certificateTrack: "contractor_works",
    });
    expect(assertReadiness).not.toHaveBeenCalled();
    expect(getSources).not.toHaveBeenCalled();
  });

  it("rejects any non-invoice source set", async () => {
    getSources.mockResolvedValue([
      { invoiceId: 31, situationId: 41 },
    ] as never);
    await expect(
      assertSupplierCertificateDispatchValid(supplierCert),
    ).rejects.toMatchObject<SupplierCertificateDispatchError>({
      code: "SUPPLIER_CERTIFICATE_SOURCE_SET_INVALID",
    });
    expect(derive).not.toHaveBeenCalled();
  });

  it("rejects a currently refused source derivation", async () => {
    derive.mockResolvedValue({
      ok: false,
      refusal: {
        status: 409,
        body: { code: "BANKING_MISMATCH", message: "mismatch" },
      },
    } as never);
    await expect(
      assertSupplierCertificateDispatchValid(supplierCert),
    ).rejects.toMatchObject<SupplierCertificateDispatchError>({
      code: "BANKING_MISMATCH",
      message: "mismatch",
    });
  });

  it("rejects a changed partner track", async () => {
    derive.mockResolvedValue({
      ok: true,
      derivation: { certificateTrack: "contractor_works" },
    } as never);
    await expect(
      assertSupplierCertificateDispatchValid(supplierCert),
    ).rejects.toMatchObject<SupplierCertificateDispatchError>({
      code: "CERTIFICATE_TRACK_IMMUTABLE",
    });
  });

  it("rejects changed sealed source amounts", async () => {
    derive.mockResolvedValue({
      ...successfulDerivation,
      derivation: {
        ...successfulDerivation.derivation,
        supplierDirectPayment: {
          ...successfulDerivation.derivation.supplierDirectPayment,
          netToPayTtc: "121.00",
        },
      },
    } as never);
    await expect(
      assertSupplierCertificateDispatchValid(supplierCert),
    ).rejects.toMatchObject<SupplierCertificateDispatchError>({
      code: "SUPPLIER_SOURCE_AMOUNT_CHANGED",
    });
  });

  it("requires reissue when banking or protected-RIB identity changed after seal", async () => {
    assertReadiness.mockResolvedValue({
      ...currentReadiness,
      provenance: { contentSha256: "b".repeat(64) },
    } as never);
    await expect(
      assertSupplierCertificateDispatchValid(supplierCert),
    ).rejects.toMatchObject<SupplierCertificateDispatchError>({
      code: "SUPPLIER_REISSUE_REQUIRED",
    });
  });

  it("requires reissue when the sealed issue date diverges", async () => {
    await expect(
      assertSupplierCertificateDispatchValid({
        ...supplierCert,
        dateIssued: "2026-08-25",
      }),
    ).rejects.toMatchObject<SupplierCertificateDispatchError>({
      code: "SUPPLIER_REISSUE_REQUIRED",
    });
    expect(assertReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ issueDate: "2026-08-25" }),
    );
  });
});