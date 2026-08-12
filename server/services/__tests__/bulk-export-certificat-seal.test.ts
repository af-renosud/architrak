import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Task #451 — bulk export must honour the issuance seal.
 *
 * - Sealed certificats (pinned pdfStorageKey, whatever their status) export
 *   their PINNED bytes via object storage — never a re-render from current
 *   data.
 * - Only unsealed "ready" drafts fall back to an ephemeral preview render.
 */

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("../../routes/__tests__/helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getProject",
      "getDevisByProject",
      "getInvoicesByProject",
      "getCertificatsByProject",
      "getLotsByProject",
      "getContractors",
    ]),
  };
});
vi.mock("../../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(),
}));
vi.mock("../../communications/certificat-generator", () => ({
  generateCertificatPdf: vi.fn(),
}));

import { generateProjectFolder } from "../bulk-export.service";
import { storage } from "../../storage";
import { getDocumentBuffer } from "../../storage/object-storage";
import { generateCertificatPdf } from "../../communications/certificat-generator";

const getProject = storage.getProject as unknown as ReturnType<typeof vi.fn>;
const getDevisByProject = storage.getDevisByProject as unknown as ReturnType<typeof vi.fn>;
const getInvoicesByProject = storage.getInvoicesByProject as unknown as ReturnType<typeof vi.fn>;
const getCertificatsByProject = storage.getCertificatsByProject as unknown as ReturnType<typeof vi.fn>;
const getLotsByProject = storage.getLotsByProject as unknown as ReturnType<typeof vi.fn>;
const getContractors = storage.getContractors as unknown as ReturnType<typeof vi.fn>;
const getBuffer = getDocumentBuffer as unknown as ReturnType<typeof vi.fn>;
const generate = generateCertificatPdf as unknown as ReturnType<typeof vi.fn>;

const baseCert = {
  id: 1,
  projectId: 1,
  contractorId: 2,
  certificateRef: "C1",
  dateIssued: "2026-08-01",
  status: "sent",
  pdfStorageKey: "projects/1/CERT-C1.pdf" as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getProject.mockResolvedValue({ id: 1, code: "P1", name: "Proj" });
  getDevisByProject.mockResolvedValue([]);
  getInvoicesByProject.mockResolvedValue([]);
  getLotsByProject.mockResolvedValue([]);
  getContractors.mockResolvedValue([{ id: 2, name: "Contractor" }]);
  getBuffer.mockResolvedValue(Buffer.from("%PDF-pinned"));
  generate.mockResolvedValue({ pdfBuffer: Buffer.from("%PDF-render"), storageKey: null, fileName: "x.pdf", sourceInvoiceIds: [] });
});

describe("generateProjectFolder — certificat seal", () => {
  it("exports a sealed certificat from its pinned bytes without re-rendering", async () => {
    getCertificatsByProject.mockResolvedValue([baseCert]);
    const zip = await generateProjectFolder(1);
    expect(zip.length).toBeGreaterThan(0);
    expect(getBuffer).toHaveBeenCalledWith("projects/1/CERT-C1.pdf");
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses pinned bytes for sealed 'sent'/'paid' certificats too", async () => {
    getCertificatsByProject.mockResolvedValue([
      { ...baseCert, id: 2, certificateRef: "C2", status: "sent", pdfStorageKey: "k2.pdf" },
      { ...baseCert, id: 3, certificateRef: "C3", status: "paid", pdfStorageKey: "k3.pdf" },
    ]);
    await generateProjectFolder(1);
    expect(getBuffer).toHaveBeenCalledWith("k2.pdf");
    expect(getBuffer).toHaveBeenCalledWith("k3.pdf");
    expect(generate).not.toHaveBeenCalled();
  });

  it("falls back to an ephemeral preview render only for unsealed 'ready' drafts", async () => {
    getCertificatsByProject.mockResolvedValue([
      { ...baseCert, id: 4, certificateRef: "C4", status: "ready", pdfStorageKey: null },
      { ...baseCert, id: 5, certificateRef: "C5", status: "draft", pdfStorageKey: null },
    ]);
    await generateProjectFolder(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(4, { mode: "preview" });
    expect(getBuffer).not.toHaveBeenCalled();
  });

  it("never regenerates UNSEALED sent/paid certificats (pre-seal historical rows are excluded, not re-rendered)", async () => {
    getCertificatsByProject.mockResolvedValue([
      { ...baseCert, id: 6, certificateRef: "C6", status: "sent", pdfStorageKey: null },
      { ...baseCert, id: 7, certificateRef: "C7", status: "paid", pdfStorageKey: null },
    ]);
    const zip = await generateProjectFolder(1);
    expect(zip.length).toBeGreaterThan(0);
    // Re-rendering an issued-but-unpinned certificat from current data would
    // recreate exactly the audit drift the seal exists to prevent.
    expect(generate).not.toHaveBeenCalled();
    expect(getBuffer).not.toHaveBeenCalled();
  });
});
