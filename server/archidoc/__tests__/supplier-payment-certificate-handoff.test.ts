import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    ARCHIDOC_BASE_URL: "https://archidoc.example.test",
    ARCHIDOC_SYNC_API_KEY: "test-credential",
    ARCHIDOC_SYNC_API_KEY_NEXT: undefined as string | undefined,
  },
}));
vi.mock("../../env", () => ({ env: mockEnv }));
import {
  ArchidocFetchError,
  fetchSupplierPaymentCertificateHandoff,
  SupplierPaymentCertificateNotReadyError,
  verifySupplierProtectedRib,
} from "../sync-client";

const supplierId = "supplier-15";
const projectId = "project-1181";
const issueDate = "2026-08-28";
const documentId = "rib-current";
const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
const pdfHash = createHash("sha256").update(pdf).digest("hex");

function handoff() {
  return {
    contractVersion: "supplier-payment-certificate-handoff.v1",
    projectId,
    issueDate,
    supplier: {
      id: supplierId,
      partnerType: "supplier",
      name: "Supplier",
      siret: "73282932000074",
      address1: "1 rue Exemple",
      address2: null,
      town: "Lyon",
      postcode: "69000",
      countryCode: "FR",
      isActive: true,
      primaryContact: {
        id: "contact-1",
        name: "Contact",
        jobTitle: null,
        email: "contact@example.test",
        mobile: null,
      },
      banking: {
        accountHolderName: "Supplier",
        iban: "FR7630006000011234567890189",
        bic: "AGRIFRPPXXX",
        bankName: "Bank",
        bankingVerificationStatus: "verified",
        bankingVerifiedAt: "2026-08-20T14:32:00Z",
        bankingVerifiedBy: { id: "user-1", displayName: "Reviewer" },
        bankingVerificationMethod: "manual_rib_review",
        ribDocument: {
          id: documentId,
          fileName: "rib.pdf",
          mimeType: "application/pdf",
          sha256: pdfHash,
          downloadPath:
            `/api/integrations/architrak/v1/suppliers/${supplierId}/rib/${documentId}`,
          updatedAt: "2026-08-20T14:32:00Z",
        },
      },
      updatedAt: "2026-08-24T09:12:00Z",
    },
    assignment: {
      id: "assignment-1",
      projectId,
      directPaymentStatus: "eligible",
      validFrom: "2026-08-01",
      validUntil: null,
      reason: null,
      updatedAt: "2026-08-24T09:12:00Z",
    },
  };
}

beforeEach(() => {
  mockEnv.ARCHIDOC_BASE_URL = "https://archidoc.example.test";
  mockEnv.ARCHIDOC_SYNC_API_KEY = "test-credential";
  mockEnv.ARCHIDOC_SYNC_API_KEY_NEXT = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("supplier payment-certificate handoff client", () => {
  it("strictly accepts a correctly bound handoff", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(handoff()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
    await expect(fetchSupplierPaymentCertificateHandoff({
      supplierArchidocId: supplierId,
      projectArchidocId: projectId,
      issueDate,
    })).resolves.toMatchObject({ projectId, issueDate });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("payment-certificate-handoff"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-credential",
        }),
      }),
    );
  });

  it("maps the documented not-ready response without consuming its details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        code: "SUPPLIER_NOT_PAYMENT_READY",
        details: { sensitive: "not surfaced" },
      }), { status: 409 }),
    ));
    await expect(fetchSupplierPaymentCertificateHandoff({
      supplierArchidocId: supplierId,
      projectArchidocId: projectId,
      issueDate,
    })).rejects.toBeInstanceOf(SupplierPaymentCertificateNotReadyError);
  });

  it.each([401, 500])("fails closed for HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("", { status }),
    ));
    await expect(fetchSupplierPaymentCertificateHandoff({
      supplierArchidocId: supplierId,
      projectArchidocId: projectId,
      issueDate,
    })).rejects.toBeInstanceOf(ArchidocFetchError);
  });

  it("fails closed for a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(fetchSupplierPaymentCertificateHandoff({
      supplierArchidocId: supplierId,
      projectArchidocId: projectId,
      issueDate,
    })).rejects.toMatchObject({ diagnostic: { code: "network_error" } });
  });

  it("validates current protected PDF bytes without returning them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(pdf, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    ));
    await expect(verifySupplierProtectedRib({
      supplierArchidocId: supplierId,
      documentId,
      expectedSha256: pdfHash,
      downloadPath:
        `/api/integrations/architrak/v1/suppliers/${supplierId}/rib/${documentId}`,
    })).resolves.toBeUndefined();
  });

  it("rejects stale RIB and mismatched bytes without including protected metadata", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 409 }))
      .mockResolvedValueOnce(new Response(
        Buffer.from("%PDF-1.4\nchanged\n%%EOF"),
        { status: 200, headers: { "content-type": "application/pdf" } },
      )));
    const input = {
      supplierArchidocId: supplierId,
      documentId,
      expectedSha256: pdfHash,
      downloadPath:
        `/api/integrations/architrak/v1/suppliers/${supplierId}/rib/${documentId}`,
    };
    for (const expectedCode of ["invalid_response", "invalid_response"]) {
      try {
        await verifySupplierProtectedRib(input);
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toMatchObject({ diagnostic: { code: expectedCode } });
        expect(String(error)).not.toContain(pdfHash);
        expect(String(error)).not.toContain(documentId);
      }
    }
  });
});