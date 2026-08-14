import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Task #451 — unit pins for the certificat seal service.
 *
 * - Already-sealed certificats are NEVER re-rendered: the pinned key is
 *   reused verbatim (re-send attaches the exact issued bytes).
 * - First seal renders in "issue" mode, writes the seal via the conditional
 *   UPDATE guarded by the version captured BEFORE rendering, and records
 *   certificat_sources (invoices + FK-linked situations) atomically.
 * - A financial PATCH interleaved with the render bumps the version, the
 *   guard misses, and the sealer re-renders from the fresh inputs.
 * - Losing the concurrent-send race falls back to the winner's pinned key.
 * - The Drive mirror is enqueued ONLY by the seal winner, with the pinned
 *   key — losers never submit a competing (docKind, docId) queue entry.
 */

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("../../routes/__tests__/helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getCertificat",
      "sealCertificat",
      "getInvoice",
      "getSituationsByDevis",
      "updateCertificat",
    ]),
  };
});
vi.mock("../../communications/certificat-generator", () => ({
  generateCertificatPdf: vi.fn(),
}));
vi.mock("../drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn().mockResolvedValue(undefined),
}));
// Task #462 — the seal re-resolves deductions authoritatively before
// rendering. Mocked here; the default (set in beforeEach) mirrors the
// stored figures so the no-drift path proceeds straight to sealing.
vi.mock("../certificat-deductions.service", () => ({
  resolveCertificatDeductions: vi.fn(),
}));

import { sealCertificat } from "../certificat-seal.service";
import { storage } from "../../storage";
import { generateCertificatPdf } from "../../communications/certificat-generator";
import { enqueueDriveUpload } from "../drive/upload-queue.service";
import { resolveCertificatDeductions } from "../certificat-deductions.service";

const getCertificat = storage.getCertificat as unknown as ReturnType<typeof vi.fn>;
const sealCertificatStore = storage.sealCertificat as unknown as ReturnType<typeof vi.fn>;
const resolveDeductions = resolveCertificatDeductions as unknown as ReturnType<typeof vi.fn>;
const getInvoice = storage.getInvoice as unknown as ReturnType<typeof vi.fn>;
const getSituationsByDevis = storage.getSituationsByDevis as unknown as ReturnType<typeof vi.fn>;
const generate = generateCertificatPdf as unknown as ReturnType<typeof vi.fn>;
const driveEnqueue = enqueueDriveUpload as unknown as ReturnType<typeof vi.fn>;

const draftCert = {
  id: 5,
  projectId: 1,
  contractorId: 2,
  certificateRef: "C1",
  dateIssued: null,
  totalWorksHt: "1000.00",
  pvMvAdjustment: "0.00",
  previousPayments: "0.00",
  retenueGarantie: "50.00",
  cumulativeProrataDeduction: "0.00",
  periodProrataDeduction: "0.00",
  cumulativeAcompteRecoupment: "0.00",
  periodAcompteRecoupment: "0.00",
  netToPayHt: "950.00",
  tvaAmount: "190.00",
  netToPayTtc: "1140.00",
  status: "draft",
  pdfStorageKey: null,
  version: 1,
};

// Mirrors a certificat row's server-derived money fields back as the
// resolver result — i.e. "the world has not moved since create/PATCH".
const mirrorDeductions = (cert: typeof draftCert) => ({
  retenueGarantie: cert.retenueGarantie,
  cumulativeProrataDeduction: cert.cumulativeProrataDeduction,
  periodProrataDeduction: cert.periodProrataDeduction,
  cumulativeAcompteRecoupment: cert.cumulativeAcompteRecoupment,
  periodAcompteRecoupment: cert.periodAcompteRecoupment,
  netToPayHt: cert.netToPayHt,
  tvaAmount: cert.tvaAmount,
  netToPayTtc: cert.netToPayTtc,
});

const renderResult = (key: string, sourceInvoiceIds: number[] = []) => ({
  storageKey: key,
  pdfBuffer: Buffer.from("%PDF"),
  fileName: "CERT.pdf",
  sourceInvoiceIds,
  driveSeed: { projectId: 1, lotId: 4, displayName: "CERT.pdf", seedDevisCode: "DV1" },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sealCertificat", () => {
  it("reuses the pinned key without re-rendering when already sealed", async () => {
    getCertificat.mockResolvedValue({ ...draftCert, pdfStorageKey: "pinned.pdf" });
    const result = await sealCertificat(5);
    expect(result.alreadySealed).toBe(true);
    expect(result.pdfStorageKey).toBe("pinned.pdf");
    expect(generate).not.toHaveBeenCalled();
    expect(sealCertificatStore).not.toHaveBeenCalled();
    expect(driveEnqueue).not.toHaveBeenCalled();
  });

  it("renders once in issue mode, seals with the pre-render version, and records invoice + situation sources", async () => {
    getCertificat.mockResolvedValue({ ...draftCert, version: 7 });
    generate.mockResolvedValue(renderResult("new-key.pdf", [11, 12]));
    sealCertificatStore.mockResolvedValue({ ...draftCert, pdfStorageKey: "new-key.pdf" });
    getInvoice.mockImplementation(async (id: number) => ({ id, devisId: 99 }));
    getSituationsByDevis.mockResolvedValue([
      { id: 31, invoiceId: 11 },
      { id: 32, invoiceId: null },
      { id: 33, invoiceId: 777 },
    ]);

    const result = await sealCertificat(5);
    expect(result.alreadySealed).toBe(false);
    expect(result.pdfStorageKey).toBe("new-key.pdf");
    expect(generate).toHaveBeenCalledWith(5, { mode: "issue" });
    expect(sealCertificatStore).toHaveBeenCalledTimes(1);
    // The seal is guarded by the version captured BEFORE rendering.
    expect(sealCertificatStore.mock.calls[0][1].expectedVersion).toBe(7);
    // Source rows travel INSIDE the seal call — atomic with the seal columns.
    const rows = sealCertificatStore.mock.calls[0][1].sourceRows;
    expect(rows).toEqual(
      expect.arrayContaining([
        { certificatId: 5, invoiceId: 11, situationId: null },
        { certificatId: 5, invoiceId: 12, situationId: null },
        { certificatId: 5, situationId: 31, invoiceId: null },
      ]),
    );
    // Situations not FK-linked to a certified invoice are excluded.
    expect(rows).toHaveLength(3);
    // Winner enqueues the Drive mirror with the PINNED key.
    expect(driveEnqueue).toHaveBeenCalledTimes(1);
    expect(driveEnqueue.mock.calls[0][0]).toMatchObject({
      docKind: "certificat",
      docId: 5,
      sourceStorageKey: "new-key.pdf",
    });
  });

  it("re-renders from fresh inputs when a PATCH bumps the version mid-render (guard miss, still unsealed)", async () => {
    // Attempt 1 captures version 1; a PATCH bumps it to 2 during the render,
    // so the guarded seal misses and the row is STILL unsealed on reload.
    getCertificat
      .mockResolvedValueOnce({ ...draftCert, version: 1, netToPayTtc: "1140.00" }) // attempt 1 capture
      .mockResolvedValueOnce({ ...draftCert, version: 2, netToPayTtc: "999.00", pdfStorageKey: null }) // reload: unsealed, drifted
      .mockResolvedValueOnce({ ...draftCert, version: 2, netToPayTtc: "999.00", pdfStorageKey: null }); // attempt 2 capture
    generate
      .mockResolvedValueOnce(renderResult("stale-render.pdf"))
      .mockResolvedValueOnce(renderResult("fresh-render.pdf"));
    sealCertificatStore
      .mockResolvedValueOnce(null) // version guard missed
      .mockResolvedValueOnce({ ...draftCert, version: 2, pdfStorageKey: "fresh-render.pdf" });

    const result = await sealCertificat(5);
    expect(result.alreadySealed).toBe(false);
    expect(result.pdfStorageKey).toBe("fresh-render.pdf");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(sealCertificatStore.mock.calls[0][1].expectedVersion).toBe(1);
    expect(sealCertificatStore.mock.calls[1][1].expectedVersion).toBe(2);
    // Snapshot of the second (successful) seal reflects the PATCHed inputs.
    expect(sealCertificatStore.mock.calls[1][1].issuanceSnapshot.netToPayTtc).toBe("999.00");
    expect(sealCertificatStore.mock.calls[1][1].pdfStorageKey).toBe("fresh-render.pdf");
    // Drive is enqueued once, by the eventual winner, with the pinned key.
    expect(driveEnqueue).toHaveBeenCalledTimes(1);
    expect(driveEnqueue.mock.calls[0][0].sourceStorageKey).toBe("fresh-render.pdf");
  });

  it("gives up with a clear error when edits keep changing the inputs", async () => {
    getCertificat.mockResolvedValue({ ...draftCert, version: 1, pdfStorageKey: null });
    generate.mockResolvedValue(renderResult("render.pdf"));
    sealCertificatStore.mockResolvedValue(null); // guard always misses
    await expect(sealCertificat(5)).rejects.toThrow(/could not be sealed after/);
    expect(driveEnqueue).not.toHaveBeenCalled();
  });

  it("falls back to the winner's pinned key when the conditional UPDATE loses the race — and never enqueues Drive", async () => {
    getCertificat
      .mockResolvedValueOnce(draftCert) // initial load: unsealed
      .mockResolvedValueOnce({ ...draftCert, pdfStorageKey: "winner.pdf" }); // reload after lost race
    generate.mockResolvedValue(renderResult("loser-orphan.pdf"));
    sealCertificatStore.mockResolvedValue(null); // conditional UPDATE matched no row

    const result = await sealCertificat(5);
    expect(result.alreadySealed).toBe(true);
    expect(result.pdfStorageKey).toBe("winner.pdf");
    // The loser must NOT submit its orphan render to the Drive queue — the
    // queue dedupes on (docKind, docId) and would keep the loser's key.
    expect(driveEnqueue).not.toHaveBeenCalled();
  });
});
