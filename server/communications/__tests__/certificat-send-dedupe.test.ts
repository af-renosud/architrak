import { describe, it, expect, vi, beforeEach } from "vitest";

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
  isGmailConfigured: vi.fn().mockReturnValue(false),
}));

import { sendCertificat } from "../email-sender";
import { storage } from "../../storage";
import { sealCertificat } from "../../services/certificat-seal.service";
import { buildCertificatEmailBody } from "../certificat-generator";

const buildBody = buildCertificatEmailBody as unknown as ReturnType<typeof vi.fn>;
const getProject = storage.getProject as unknown as ReturnType<typeof vi.fn>;
const getContractor = storage.getContractor as unknown as ReturnType<typeof vi.fn>;
const createComm = storage.createProjectCommunication as unknown as ReturnType<typeof vi.fn>;
const seal = sealCertificat as unknown as ReturnType<typeof vi.fn>;

const sealedCert = {
  id: 7,
  projectId: 1,
  contractorId: 2,
  certificateRef: "C7",
  netToPayTtc: "1140.00",
  pdfStorageKey: "projects/1/CERT-C7.pdf",
};

beforeEach(() => {
  vi.clearAllMocks();
  buildBody.mockReturnValue("BODY");
  getProject.mockResolvedValue({
    id: 1,
    name: "Proj",
    clientName: "Client",
    clientAddress: "51 VICTORIA HOUSE, LONDON",
    clientContactEmail: "client@example.com",
  });
  getContractor.mockResolvedValue({ id: 2, name: "Contractor", ribDocumentUrl: null });
  seal.mockResolvedValue({ pdfStorageKey: "projects/1/CERT-C7.pdf", alreadySealed: false, certificat: sealedCert });
  createComm.mockImplementation(async (data: { dedupeKey?: string }) => ({ id: 55, ...data }));
});

describe("sendCertificat — dedupe key (Task #451)", () => {
  it("creates the communication with a dedupe key stable per issuance", async () => {
    await sendCertificat(7);
    expect(createComm).toHaveBeenCalledTimes(1);
    expect(createComm.mock.calls[0][0].dedupeKey).toBe(
      "certificat_sent:7:projects/1/CERT-C7.pdf"
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
    expect(seen.size).toBe(1);
  });
});

describe("sendCertificat — recipient resolution (Task #478)", () => {
  it("uses clientContactEmail as the recipient, never the postal clientAddress", async () => {
    await sendCertificat(7);
    expect(createComm).toHaveBeenCalledTimes(1);
    expect(createComm.mock.calls[0][0].recipientEmail).toBe("client@example.com");
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
