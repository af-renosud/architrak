import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

/**
 * Task #451 — route-level pin for the certificat issuance seal.
 *
 * Once a certificat carries a pinned pdfStorageKey it is an issued payment
 * instruction: financial/source edits via the generic PATCH must come back
 * 409 { code: "CERTIFICAT_SEALED" } and NEVER reach storage.updateCertificat.
 * Lifecycle-only patches (status/notes) still flow. The pinned-PDF download
 * route 404s on drafts and streams the pinned bytes on sealed rows.
 */

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("./helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getCertificat",
      "updateCertificat",
      "getCertificatSources",
      "getCertificatPayments",
      "getProject",
    ]),
  };
});

vi.mock("../../communications/certificat-generator", () => ({
  generateCertificatPdf: vi.fn(),
  BankingDetailsMissingError: class extends Error {},
  BankingMismatchError: class extends Error {},
}));
vi.mock("../../communications/email-sender", () => ({ sendCertificat: vi.fn() }));
vi.mock("../../services/supplier-certificate-dispatch.service", () => ({
  assertSupplierCertificateDispatchValid: vi.fn(),
  SupplierCertificateDispatchError: class extends Error {},
}));
vi.mock("../../services/supplier-certificate-rollout.service", () => ({
  isSupplierDirectPaymentAllowedForProject: vi.fn().mockReturnValue(true),
  SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED:
    "SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED",
}));
vi.mock("../../services/certificat-deductions.service", () => ({
  resolveCertificatDeductions: vi.fn().mockResolvedValue({
    retenueGarantie: "0.00",
    cumulativeProrataDeduction: "0.00",
    periodProrataDeduction: "0.00",
    netToPayHt: "100.00",
    tvaAmount: "20.00",
    netToPayTtc: "120.00",
  }),
}));
vi.mock("../../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn().mockResolvedValue(Buffer.from("%PDF-pinned")),
}));

import certificatsRouter from "../certificats";
import { storage } from "../../storage";
import { generateCertificatPdf } from "../../communications/certificat-generator";
import { isSupplierDirectPaymentAllowedForProject } from "../../services/supplier-certificate-rollout.service";

const getCertificat = storage.getCertificat as unknown as ReturnType<typeof vi.fn>;
const updateCertificat = storage.updateCertificat as unknown as ReturnType<typeof vi.fn>;
const getCertificatPayments = storage.getCertificatPayments as unknown as ReturnType<typeof vi.fn>;
const getProject = storage.getProject as unknown as ReturnType<typeof vi.fn>;
const generatePdf =
  generateCertificatPdf as unknown as ReturnType<typeof vi.fn>;
const supplierRolloutAllowed =
  isSupplierDirectPaymentAllowedForProject as unknown as ReturnType<
    typeof vi.fn
  >;

const sealedCert = {
  id: 7,
  projectId: 1,
  contractorId: 2,
  certificateRef: "C3",
  dateIssued: "2026-08-01",
  totalWorksHt: "1000.00",
  pvMvAdjustment: "0.00",
  previousPayments: "0.00",
  retenueGarantie: "50.00",
  cumulativeProrataDeduction: "0.00",
  periodProrataDeduction: "0.00",
  netToPayHt: "950.00",
  tvaAmount: "190.00",
  netToPayTtc: "1140.00",
  status: "sent",
  notes: null,
  driveFileId: null,
  driveWebViewLink: null,
  driveUploadedAt: null,
  pdfStorageKey: "projects/1/CERT-P-C3.pdf",
  pdfFileName: "CERT-P-C3.pdf",
  issuedAt: new Date("2026-08-01T10:00:00Z"),
  issuanceSnapshot: { netToPayTtc: "1140.00" },
  createdAt: new Date(),
};

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(certificatsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  supplierRolloutAllowed.mockReturnValue(true);
});

describe("POST /api/certificats/:id/preview — supplier rollout", () => {
  it("blocks an unsealed supplier draft outside the project canary", async () => {
    getCertificat.mockResolvedValue({
      ...sealedCert,
      certificateTrack: "supplier_direct_payment",
      pdfStorageKey: null,
      issuedAt: null,
      status: "draft",
    });
    getProject.mockResolvedValue({
      id: 1,
      archidocId: "project-not-allowlisted",
    });
    supplierRolloutAllowed.mockReturnValue(false);

    const res = await fetch(`${baseUrl}/api/certificats/7/preview`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED",
    });
    expect(generatePdf).not.toHaveBeenCalled();
  });

  it.each([
    ["missing project", undefined],
    ["project without ArchiDoc identity", { id: 1, archidocId: null }],
  ])("fails closed for an unsealed supplier draft with %s", async (_label, project) => {
    getCertificat.mockResolvedValue({
      ...sealedCert,
      certificateTrack: "supplier_direct_payment",
      pdfStorageKey: null,
      issuedAt: null,
      status: "draft",
    });
    getProject.mockResolvedValue(project);

    const res = await fetch(`${baseUrl}/api/certificats/7/preview`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED",
    });
    expect(supplierRolloutAllowed).not.toHaveBeenCalled();
    expect(generatePdf).not.toHaveBeenCalled();
  });

  it("continues serving pinned supplier history after the canary is disabled", async () => {
    getCertificat.mockResolvedValue({
      ...sealedCert,
      certificateTrack: "supplier_direct_payment",
    });
    supplierRolloutAllowed.mockReturnValue(false);

    const res = await fetch(`${baseUrl}/api/certificats/7/preview`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-pinned");
    expect(supplierRolloutAllowed).not.toHaveBeenCalled();
    expect(generatePdf).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/certificats/:id — issuance seal", () => {
  it("rejects financial edits on a sealed certificat with 409 and never touches storage", async () => {
    getCertificat.mockResolvedValue(sealedCert);
    const res = await fetch(`${baseUrl}/api/certificats/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totalWorksHt: "9999.00" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CERTIFICAT_SEALED");
    expect(body.blockedFields).toContain("totalWorksHt");
    expect(updateCertificat).not.toHaveBeenCalled();
  });

  it("rejects deduction overrides on a sealed certificat", async () => {
    getCertificat.mockResolvedValue(sealedCert);
    const res = await fetch(`${baseUrl}/api/certificats/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retenueOverride: "0.00" }),
    });
    expect(res.status).toBe(409);
    expect(updateCertificat).not.toHaveBeenCalled();
  });

  it("still allows lifecycle-only patches (status/notes) on a sealed certificat", async () => {
    getCertificat.mockResolvedValue(sealedCert);
    updateCertificat.mockResolvedValue({ ...sealedCert, status: "sent" });
    const res = await fetch(`${baseUrl}/api/certificats/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "sent", notes: "sent to client" }),
    });
    expect(res.status).toBe(200);
    expect(updateCertificat).toHaveBeenCalledWith(7, { status: "sent", notes: "sent to client" });
  });

  // Task #465 — a sealed certificat's `paid` status must be BACKED by the
  // payment ledger: manual flips are refused until coverage reaches the TTC
  // total, at which point the ledger flips the status automatically anyway.
  it("refuses status=paid on a sealed certificat without full payment coverage", async () => {
    getCertificat.mockResolvedValue(sealedCert);
    getCertificatPayments.mockResolvedValue([]);
    const res = await fetch(`${baseUrl}/api/certificats/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paid" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PAYMENTS_INCOMPLETE");
    expect(updateCertificat).not.toHaveBeenCalled();
  });

  it("allows status=paid on a sealed certificat once payments cover the TTC total", async () => {
    getCertificat.mockResolvedValue(sealedCert);
    getCertificatPayments.mockResolvedValue([{ id: 1, certificatId: 7, amount: sealedCert.netToPayTtc }]);
    updateCertificat.mockResolvedValue({ ...sealedCert, status: "paid" });
    const res = await fetch(`${baseUrl}/api/certificats/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paid" }),
    });
    expect(res.status).toBe(200);
  });

  it("never lets seal columns through the PATCH body even on drafts", async () => {
    getCertificat.mockResolvedValue({ ...sealedCert, pdfStorageKey: null, issuedAt: null, status: "draft" });
    updateCertificat.mockResolvedValue({ ...sealedCert, pdfStorageKey: null });
    const res = await fetch(`${baseUrl}/api/certificats/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "x", pdfStorageKey: "evil", issuedAt: "2020-01-01", issuanceSnapshot: {} }),
    });
    expect(res.status).toBe(200);
    expect(updateCertificat).toHaveBeenCalledWith(7, { notes: "x" });
  });
});

describe("GET /api/certificats/:id/pdf — pinned bytes", () => {
  it("404s with CERTIFICAT_NOT_SEALED on a draft", async () => {
    getCertificat.mockResolvedValue({ ...sealedCert, pdfStorageKey: null });
    const res = await fetch(`${baseUrl}/api/certificats/7/pdf`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("CERTIFICAT_NOT_SEALED");
  });

  it("streams the pinned PDF on a sealed certificat", async () => {
    getCertificat.mockResolvedValue(sealedCert);
    const res = await fetch(`${baseUrl}/api/certificats/7/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(await res.text()).toBe("%PDF-pinned");
  });
});
