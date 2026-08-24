import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

/**
 * Task #451 — idempotent concurrent certificat send.
 *
 * `sendCertificat` must create the project communication with a dedupe key
 * that is STABLE per issuance (certificat id + pinned pdfStorageKey). The
 * storage layer's unique index on dedupe_key then collapses racing/repeated
 * send requests onto ONE queued email — the client can never receive
 * duplicate payment instructions for the same issuance.
 */

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("../../routes/__tests__/helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getCertificat",
      "getProject",
      "getContractor",
      "createProjectCommunication",
      "updateProjectCommunication",
      "requeueFailedProjectCommunication",
      "claimProjectCommunicationForSending",
      "getProjectCommunication",
      "markProjectCommunicationSent",
    ]),
  };
});
vi.mock("../../services/certificat-seal.service", () => ({
  sealCertificat: vi.fn(),
}));
vi.mock("../certificat-generator", () => ({
  buildCertificatEmailBody: vi.fn().mockReturnValue("BODY"),
}));
vi.mock("../../gmail/client", () => ({
  getUncachableGmailClient: vi.fn(),
  isGmailConfigured: vi.fn().mockReturnValue(true),
  isFakeGmailMode: vi.fn().mockReturnValue(true),
}));
vi.mock("../../env", () => ({
  env: {
    ARCHIDOC_BASE_URL: "https://archidoc.example.test",
    ARCHIDOC_SYNC_API_KEY: "test-sync-key",
  },
}));
vi.mock("../../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(),
  uploadDocument: vi.fn(),
}));

import { sendCertificat, sendCommunication } from "../email-sender";
import { storage } from "../../storage";
import { sealCertificat } from "../../services/certificat-seal.service";
import { buildCertificatEmailBody } from "../certificat-generator";
import {
  getDocumentBuffer,
  uploadDocument,
} from "../../storage/object-storage";
import { getUncachableGmailClient } from "../../gmail/client";

const buildBody = buildCertificatEmailBody as unknown as ReturnType<typeof vi.fn>;
const getProject = storage.getProject as unknown as ReturnType<typeof vi.fn>;
const getContractor = storage.getContractor as unknown as ReturnType<typeof vi.fn>;
const createComm = storage.createProjectCommunication as unknown as ReturnType<typeof vi.fn>;
const updateComm = storage.updateProjectCommunication as unknown as ReturnType<typeof vi.fn>;
const requeueFailedComm =
  storage.requeueFailedProjectCommunication as unknown as ReturnType<
    typeof vi.fn
  >;
const seal = sealCertificat as unknown as ReturnType<typeof vi.fn>;
const upload = uploadDocument as unknown as ReturnType<typeof vi.fn>;
const getBuffer = getDocumentBuffer as unknown as ReturnType<typeof vi.fn>;
const getGmail =
  getUncachableGmailClient as unknown as ReturnType<typeof vi.fn>;
const claimComm =
  storage.claimProjectCommunicationForSending as unknown as ReturnType<
    typeof vi.fn
  >;

const sealedCert = {
  id: 7,
  projectId: 1,
  contractorId: 2,
  certificateRef: "C7",
  netToPayTtc: "1140.00",
  pdfStorageKey: "projects/1/CERT-C7.pdf",
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  buildBody.mockReturnValue("BODY");
  getProject.mockResolvedValue({
    id: 1,
    name: "Proj",
    clientName: "Client",
    clientAddress: "51 VICTORIA HOUSE, LONDON",
    clientContactEmail: "client@example.com",
  });
  getContractor.mockResolvedValue({ id: 2, name: "Contractor", email: "entreprise@example.com", ribDocumentUrl: null });
  seal.mockResolvedValue({ pdfStorageKey: "projects/1/CERT-C7.pdf", alreadySealed: false, certificat: sealedCert });
  createComm.mockImplementation(async (data: { dedupeKey?: string }) => ({ id: 55, ...data }));
  updateComm.mockImplementation(
    async (id: number, data: Record<string, unknown>) => ({
      id,
      status: "failed",
      ...data,
    }),
  );
  requeueFailedComm.mockResolvedValue({ id: 55, status: "queued" });
  upload.mockResolvedValue("projects/1/RIB-FOURNISSEUR-RIB.pdf");
  getGmail.mockResolvedValue({
    users: { messages: { send: vi.fn() } },
  });
});

// Task #519 — every certificat send now creates TWO communications: the
// client email and the contractor payment notice. Helpers pick each by type.
const clientCalls = () => createComm.mock.calls.filter((c) => c[0].type === "certificat_sent");
const noticeCalls = () => createComm.mock.calls.filter((c) => c[0].type === "certificat_contractor_notice");
const supplierNoticeCalls = () =>
  createComm.mock.calls.filter(
    (c) => c[0].type === "certificat_supplier_notice",
  );

function supplierIssuanceSnapshot(ribSha256: string) {
  return {
    supplierDirectPayment: {
      readiness: {
        schemaVersion: "1.0",
        provenance: {
          schemaVersion: "1.0",
          sourceSequence: "42",
          capturedAt: "2026-08-24T10:00:00.000Z",
          contentSha256: "a".repeat(64),
        },
        supplier: {
          id: "supplier-2",
          name: "Supplier",
          siret: "12345678901234",
          address1: "1 rue Test",
          address2: null,
          postcode: "75001",
          town: "Paris",
          countryCode: "FR",
          email: "supplier@example.com",
          phone: null,
          legalIdentityStatus: "verified",
          primaryContact: {
            id: "contact-1",
            name: "Supplier Contact",
            jobTitle: "Accounts",
            email: "supplier@example.com",
            phone: null,
            isPrimary: true,
          },
          banking: {
            accountHolderName: "Supplier",
            iban: "FR7630006000011234567890189",
            bic: "AGRIFRPP",
            bankName: "Bank",
            bankingStatus: "verified",
            bankingVerifiedAt: "2026-08-23T09:00:00.000Z",
            bankingVerifiedBy: {
              userId: "user-1",
              displayName: "Alice",
            },
            ribDocument: {
              id: "rib-1",
              fileName: "RIB.pdf",
              mimeType: "application/pdf",
              sha256: ribSha256,
              downloadPath:
                "/api/integrations/architrak/v1/suppliers/supplier-2/rib/rib-1",
            },
          },
        },
        assignment: {
          id: "assignment-1",
          projectId: "project-1",
          supplierId: "supplier-2",
          status: "active",
          directPaymentStatus: "eligible",
          validFrom: "2026-01-01",
          validUntil: null,
          notes: null,
        },
      },
      presentation: {
        certificateRef: "C7",
        issueDate: "2026-08-24",
        project: {
          id: 1,
          archidocId: "project-1",
          code: "P1",
          name: "Proj",
          clientName: "Client",
          clientContactEmail: "client@example.com",
          clientAddress: null,
        },
        supplier: {
          id: "supplier-2",
          name: "Supplier",
          siret: "12345678901234",
          address1: "1 rue Test",
          address2: null,
          postcode: "75001",
          town: "Paris",
          countryCode: "FR",
          contactName: "Supplier Contact",
          contactJobTitle: "Accounts",
          contactEmail: "supplier@example.com",
        },
        banking: {
          accountHolderName: "Supplier",
          iban: "FR7630006000011234567890189",
          bic: "AGRIFRPP",
          bankName: "Bank",
          verifiedAt: "2026-08-23T09:00:00.000Z",
          verifiedBy: "Alice",
        },
        assignment: {
          id: "assignment-1",
          directPaymentStatus: "eligible",
          validFrom: "2026-01-01",
          validUntil: null,
        },
        invoices: [
          {
            invoiceId: 31,
            invoiceNumber: "FAC-31",
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
          tvaRatePercent: "20.00",
          tvaAutoliquidation: false,
        },
        transferRef: "PAY-SUP-31",
      },
      sources: {
        invoices: [
          {
            invoiceId: 31,
            invoiceNumber: "FAC-31",
            invoiceDate: "2026-08-20",
            amountHt: "1000.00",
            tvaAmount: "200.00",
            amountTtc: "1200.00",
          },
        ],
      },
      paymentTransferRef: "PAY-SUP-31",
    },
  };
}

describe("sendCertificat — dedupe key (Task #451)", () => {
  it("creates both communications with dedupe keys stable per issuance", async () => {
    await sendCertificat(7);
    expect(clientCalls().length).toBe(1);
    expect(clientCalls()[0][0].dedupeKey).toBe(
      "certificat_sent:7:projects/1/CERT-C7.pdf"
    );
    expect(noticeCalls().length).toBe(1);
    expect(noticeCalls()[0][0].dedupeKey).toBe(
      "certificat_contractor_notice:7:projects/1/CERT-C7.pdf"
    );
  });

  it("builds the email body from the SEALED row, never a pre-seal fetch", async () => {
    await sendCertificat(7);
    // sendCertificat must not read the certificat itself — sealCertificat is
    // the single source of the row, so message amounts match the pinned PDF.
    expect(storage.getCertificat).not.toHaveBeenCalled();
    expect(buildBody).toHaveBeenCalledTimes(1);
    expect(buildBody.mock.calls[0][0].certificat).toBe(sealedCert);
  });

  it("repeated/concurrent sends of the same issuance produce the SAME dedupe key, so the unique index collapses them onto one row", async () => {
    // Emulate the storage layer's ON CONFLICT(dedupe_key) DO NOTHING + fetch-existing:
    const seen = new Map<string, { id: number }>();
    createComm.mockImplementation(async (data: { dedupeKey?: string }) => {
      const key = data.dedupeKey!;
      if (seen.has(key)) return seen.get(key)!;
      const row = { id: 100 + seen.size, ...data };
      seen.set(key, row);
      return row;
    });

    const [a, b, c] = await Promise.all([sendCertificat(7), sendCertificat(7), sendCertificat(7)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // One client row + one contractor-notice row, each independently deduped.
    expect(seen.size).toBe(2);
    expect([...seen.keys()].sort()).toEqual([
      "certificat_contractor_notice:7:projects/1/CERT-C7.pdf",
      "certificat_sent:7:projects/1/CERT-C7.pdf",
    ]);
  });
});

describe("sendCertificat — contractor payment notice (Task #519)", () => {
  it("queues the notice to the contractor's email with the French framing", async () => {
    await sendCertificat(7);
    const [data] = noticeCalls()[0];
    expect(data.recipientType).toBe("contractor");
    expect(data.recipientEmail).toBe("entreprise@example.com");
    expect(data.status).toBe("queued");
    expect(data.relatedCertificatId).toBe(7);
    expect(data.subject).toBe("Certificat de Paiement C7 – Proj – Paiement demandé au client");
    expect(data.body).toContain("répondre simplement à cet e-mail dès réception du paiement");
  });

  it("a missing/invalid contractor email queues the notice as FAILED without blocking the client send", async () => {
    getContractor.mockResolvedValue({ id: 2, name: "Contractor", email: null, ribDocumentUrl: null });
    await expect(sendCertificat(7)).resolves.toBeDefined();
    expect(clientCalls().length).toBe(1);
    expect(noticeCalls().length).toBe(1);
    expect(noticeCalls()[0][0].status).toBe("failed");
  });
});

describe("sendCertificat — supplier direct payment", () => {
  it("uses the protected hash-bound RIB and creates a supplier-specific notice", async () => {
    const ribBuffer = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF",
    );
    const sha256 = createHash("sha256").update(ribBuffer).digest("hex");
    const supplierCert = {
      ...sealedCert,
      certificateTrack: "supplier_direct_payment",
      netToPayHt: "1000.00",
      tvaAmount: "200.00",
      netToPayTtc: "1200.00",
      paymentTransferRef: "PAY-SUP-31",
      issuanceSnapshot: supplierIssuanceSnapshot(sha256),
    };
    seal.mockResolvedValue({
      pdfStorageKey: sealedCert.pdfStorageKey,
      alreadySealed: true,
      certificat: supplierCert,
    });
    getContractor.mockResolvedValue({
      id: 2,
      name: "Supplier",
      email: "legacy-public@example.com",
      ribDocumentUrl: "https://public.example.test/legacy.pdf",
    });
    getProject.mockResolvedValue({
      id: 1,
      name: "Renamed live project",
      clientName: "Renamed client",
      clientContactEmail: "renamed-client@example.com",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(ribBuffer, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "cache-control": "private, no-store",
            "content-disposition": 'attachment; filename="RIB.pdf"',
            etag: `"${sha256}"`,
          },
        }),
      ),
    );

    await sendCertificat(7);

    expect(fetch).toHaveBeenCalledWith(
      "https://archidoc.example.test/api/integrations/architrak/v1/suppliers/supplier-2/rib/rib-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-sync-key",
          "X-ArchiDoc-RIB-SHA256": sha256,
        }),
      }),
    );
    expect(upload).toHaveBeenCalledWith(
      1,
      "RIB-FOURNISSEUR-RIB.pdf",
      ribBuffer,
      "application/pdf",
    );
    expect(clientCalls()[0][0].subject).toContain(
      "Certificat de paiement fournisseur C7 – paiement direct client",
    );
    expect(clientCalls()[0][0].subject).toContain("– Proj");
    expect(clientCalls()[0][0].subject).not.toContain(
      "Renamed live project",
    );
    expect(clientCalls()[0][0].recipientEmail).toBe(
      "client@example.com",
    );
    expect(clientCalls()[0][0]).toEqual(
      expect.objectContaining({
        status: "failed",
        attachmentStorageKeys: ["projects/1/CERT-C7.pdf"],
      }),
    );
    expect(updateComm).toHaveBeenCalledWith(55, {
      attachmentStorageKeys: [
      "projects/1/CERT-C7.pdf",
      "projects/1/RIB-FOURNISSEUR-RIB.pdf",
      ],
    });
    expect(requeueFailedComm).toHaveBeenCalledWith(55);
    expect(noticeCalls()).toHaveLength(0);
    expect(supplierNoticeCalls()).toHaveLength(1);
    expect(supplierNoticeCalls()[0][0]).toEqual(
      expect.objectContaining({
        recipientType: "supplier",
        recipientName: "Supplier Contact",
        recipientEmail: "supplier@example.com",
        status: "queued",
        dedupeKey:
          "certificat_supplier_notice:7:projects/1/CERT-C7.pdf",
      }),
    );
    expect(supplierNoticeCalls()[0][0].body).toContain("FAC-31");
    expect(supplierNoticeCalls()[0][0].body).not.toContain(
      "travaux réalisés",
    );
  });

  it("rejects a RIB hash mismatch after sealing so the send can be retried", async () => {
    const expectedSha256 = createHash("sha256")
      .update(Buffer.from("%PDF-1.7\nexpected\n%%EOF"))
      .digest("hex");
    const supplierCert = {
      ...sealedCert,
      certificateTrack: "supplier_direct_payment",
      issuanceSnapshot: supplierIssuanceSnapshot(expectedSha256),
    };
    seal.mockResolvedValue({
      pdfStorageKey: sealedCert.pdfStorageKey,
      alreadySealed: true,
      certificat: supplierCert,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(Buffer.from("%PDF-1.7\naltered\n%%EOF"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "cache-control": "private, no-store",
            "content-disposition": 'attachment; filename="RIB.pdf"',
            etag: `"${expectedSha256}"`,
          },
        }),
      ),
    );

    await expect(sendCertificat(7)).rejects.toThrow(
      /empreinte du document ne correspond pas/i,
    );
    expect(seal).toHaveBeenCalledWith(7);
    expect(createComm).toHaveBeenCalledTimes(1);
    expect(createComm.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        type: "certificat_sent",
        status: "failed",
        attachmentStorageKeys: ["projects/1/CERT-C7.pdf"],
      }),
    );
    expect(updateComm).not.toHaveBeenCalled();
    expect(supplierNoticeCalls()).toHaveLength(0);
  });

  it("rejects a hash-matching non-PDF payload even when its headers claim PDF", async () => {
    const malicious = Buffer.from("not a pdf, but hash-bound");
    const sha256 = createHash("sha256").update(malicious).digest("hex");
    const supplierCert = {
      ...sealedCert,
      certificateTrack: "supplier_direct_payment",
      issuanceSnapshot: supplierIssuanceSnapshot(sha256),
    };
    seal.mockResolvedValue({
      pdfStorageKey: sealedCert.pdfStorageKey,
      alreadySealed: true,
      certificat: supplierCert,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(malicious, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "cache-control": "private, no-store",
            "content-disposition": 'attachment; filename="RIB.pdf"',
            etag: `"${sha256}"`,
          },
        }),
      ),
    );

    await expect(sendCertificat(7)).rejects.toThrow(
      /n'est pas un fichier PDF valide/i,
    );
    expect(updateComm).not.toHaveBeenCalled();
    expect(supplierNoticeCalls()).toHaveLength(0);
  });

  it("fails a supplier retry when the mirrored RIB object cannot be loaded", async () => {
    const sha256 = createHash("sha256")
      .update(Buffer.from("%PDF-1.7\nRIB\n%%EOF"))
      .digest("hex");
    const supplierCert = {
      ...sealedCert,
      certificateTrack: "supplier_direct_payment",
      issuanceSnapshot: supplierIssuanceSnapshot(sha256),
    };
    const gmailSend = vi.fn();
    getGmail.mockResolvedValue({
      users: { messages: { send: gmailSend } },
    });
    claimComm.mockResolvedValue({
      id: 55,
      projectId: 1,
      type: "certificat_sent",
      status: "sending",
      recipientType: "client",
      recipientEmail: "client@example.com",
      recipientName: "Client",
      subject: "Supplier payment",
      body: "Body",
      relatedCertificatId: 7,
      attachmentStorageKeys: [
        "projects/1/CERT-C7.pdf",
        "projects/1/RIB-FOURNISSEUR-RIB.pdf",
      ],
    });
    (storage.getCertificat as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue(supplierCert);
    getBuffer.mockImplementation(async (key: string) => {
      if (key.includes("RIB-FOURNISSEUR")) {
        throw new Error("object missing");
      }
      return Buffer.from("%PDF-1.7\nCERT\n%%EOF");
    });

    await expect(sendCommunication(55)).rejects.toThrow(
      /required supplier payment attachment unavailable/i,
    );
    expect(gmailSend).not.toHaveBeenCalled();
    expect(updateComm).toHaveBeenCalledWith(55, {
      status: "failed",
    });
  });
});

describe("sendCertificat — recipient resolution (Task #478)", () => {
  it("uses clientContactEmail as the recipient, never the postal clientAddress", async () => {
    await sendCertificat(7);
    expect(clientCalls().length).toBe(1);
    expect(clientCalls()[0][0].recipientEmail).toBe("client@example.com");
  });

  it("throws a clear validation error when clientContactEmail is missing", async () => {
    getProject.mockResolvedValue({
      id: 1,
      name: "Proj",
      clientName: "Client",
      clientAddress: "51 VICTORIA HOUSE, LONDON",
      clientContactEmail: null,
    });
    await expect(sendCertificat(7)).rejects.toThrow(/contact email missing/i);
    expect(createComm).not.toHaveBeenCalled();
  });

  it("rejects a non-email clientContactEmail (e.g. a postal address pasted into the field)", async () => {
    getProject.mockResolvedValue({
      id: 1,
      name: "Proj",
      clientName: "Client",
      clientContactEmail: "51 VICTORIA HOUSE, LONDON",
    });
    await expect(sendCertificat(7)).rejects.toThrow(/missing or invalid/i);
    expect(createComm).not.toHaveBeenCalled();
  });
});
