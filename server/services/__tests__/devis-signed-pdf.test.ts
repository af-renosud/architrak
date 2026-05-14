import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------
// Hoisted mocks for module-level dependencies. We mock at the boundary
// (storage, archisign, object-storage, drive queue) so the test exercises
// the real branching logic of persistSignedDevisPdf without any network
// or DB I/O.
// ---------------------------------------------------------------------
const { storageMock, archisignMock, uploadMock, driveQueueMock } = vi.hoisted(() => ({
  storageMock: {
    getDevis: vi.fn(),
    setDevisSignedPdfStorageKey: vi.fn(async () => {}),
  },
  archisignMock: {
    getSignedPdfUrl: vi.fn(),
  },
  uploadMock: {
    uploadDocument: vi.fn(async (_p: number, _name: string, _buf: Buffer) => "object/key/from-test.pdf"),
  },
  driveQueueMock: {
    enqueueDriveUpload: vi.fn(async () => undefined),
  },
}));

vi.mock("../../storage", () => ({ storage: storageMock }));
vi.mock("../archisign.js", () => ({
  getSignedPdfUrl: archisignMock.getSignedPdfUrl,
  // We re-export the real error class so `instanceof` checks inside the
  // service still resolve correctly without dragging the real Archisign
  // HTTP client into the test.
  ArchisignRetentionBreachError: class ArchisignRetentionBreachError extends Error {
    constructor(public breach: { incidentRef: string }) {
      super("retention breach");
    }
  },
}));
vi.mock("../../storage/object-storage", () => ({ uploadDocument: uploadMock.uploadDocument }));
vi.mock("../drive/upload-queue.service", () => ({ enqueueDriveUpload: driveQueueMock.enqueueDriveUpload }));

import { persistSignedDevisPdf, signedPdfFileName } from "../devis-signed-pdf.service";
import { ArchisignRetentionBreachError } from "../archisign.js";

const baseDevis = {
  id: 42,
  projectId: 7,
  lotId: 3,
  devisCode: "DEV-2026-014",
  archisignEnvelopeId: "env_abc",
  signedPdfFetchUrlSnapshot: "https://archisign.test/snap.pdf",
  signedPdfStorageKey: null as string | null,
};

function mockFetchOk(body = "fake-pdf-bytes") {
  global.fetch = vi.fn(async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/pdf" } }),
  ) as unknown as typeof fetch;
}

function mockFetchFail(status = 500) {
  global.fetch = vi.fn(async () => new Response("nope", { status })) as unknown as typeof fetch;
}

describe("signedPdfFileName", () => {
  it("uses the canonical `{devisCode} signed.pdf` shape (with the space preserved)", () => {
    expect(signedPdfFileName({ id: 1, devisCode: "DEV-2026-014" })).toBe("DEV-2026-014 signed.pdf");
  });

  it("falls back to a synthetic code when devisCode is null", () => {
    expect(signedPdfFileName({ id: 99, devisCode: null })).toBe("devis_99 signed.pdf");
  });

  it("strips path-hostile characters but keeps spaces and other innocuous chars", () => {
    expect(signedPdfFileName({ id: 1, devisCode: "DEV/2026\\014" })).toBe("DEV_2026_014 signed.pdf");
  });
});

describe("persistSignedDevisPdf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMock.getDevis.mockReset();
    storageMock.setDevisSignedPdfStorageKey.mockReset();
    archisignMock.getSignedPdfUrl.mockReset();
    uploadMock.uploadDocument.mockReset();
    uploadMock.uploadDocument.mockResolvedValue("object/key/from-test.pdf");
    driveQueueMock.enqueueDriveUpload.mockReset();
  });

  it("downloads via the snapshot URL, persists locally, and enqueues the Drive mirror with `devis_signed`", async () => {
    storageMock.getDevis.mockResolvedValue({ ...baseDevis });
    mockFetchOk();

    await persistSignedDevisPdf(42);

    expect(global.fetch).toHaveBeenCalledWith(baseDevis.signedPdfFetchUrlSnapshot, expect.anything());
    expect(archisignMock.getSignedPdfUrl).not.toHaveBeenCalled();
    expect(uploadMock.uploadDocument).toHaveBeenCalledWith(
      7,
      "DEV-2026-014 signed.pdf",
      expect.any(Buffer),
      "application/pdf",
    );
    expect(storageMock.setDevisSignedPdfStorageKey).toHaveBeenCalledWith(42, "object/key/from-test.pdf");
    expect(driveQueueMock.enqueueDriveUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        docKind: "devis_signed",
        docId: 42,
        projectId: 7,
        lotId: 3,
        sourceStorageKey: "object/key/from-test.pdf",
        displayName: "DEV-2026-014 signed.pdf",
        seedDevisCode: "DEV-2026-014",
      }),
    );
  });

  it("falls back to re-mint via getSignedPdfUrl when the snapshot URL fails", async () => {
    storageMock.getDevis.mockResolvedValue({ ...baseDevis });
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("expired", { status: 410 });
      return new Response("real-bytes", { status: 200 });
    }) as unknown as typeof fetch;
    archisignMock.getSignedPdfUrl.mockResolvedValue({ url: "https://archisign.test/reminted.pdf" });

    await persistSignedDevisPdf(42);

    expect(archisignMock.getSignedPdfUrl).toHaveBeenCalledWith("env_abc");
    expect(uploadMock.uploadDocument).toHaveBeenCalledTimes(1);
    expect(driveQueueMock.enqueueDriveUpload).toHaveBeenCalledTimes(1);
  });

  it("skips persistence (and Drive enqueue) when re-mint reports an Archisign retention breach", async () => {
    storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
    archisignMock.getSignedPdfUrl.mockRejectedValue(
      new ArchisignRetentionBreachError({ incidentRef: "inc_123" } as never),
    );

    await persistSignedDevisPdf(42);

    expect(uploadMock.uploadDocument).not.toHaveBeenCalled();
    expect(storageMock.setDevisSignedPdfStorageKey).not.toHaveBeenCalled();
    expect(driveQueueMock.enqueueDriveUpload).not.toHaveBeenCalled();
  });

  it("is idempotent: when signedPdfStorageKey already exists, skips the download but still ensures the Drive enqueue", async () => {
    storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfStorageKey: "existing/key.pdf" });
    global.fetch = vi.fn() as unknown as typeof fetch;

    await persistSignedDevisPdf(42);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(uploadMock.uploadDocument).not.toHaveBeenCalled();
    expect(storageMock.setDevisSignedPdfStorageKey).not.toHaveBeenCalled();
    expect(driveQueueMock.enqueueDriveUpload).toHaveBeenCalledWith(
      expect.objectContaining({ docKind: "devis_signed", sourceStorageKey: "existing/key.pdf" }),
    );
  });

  it("never throws on unexpected failures (best-effort contract — webhook handler must keep its 200 response)", async () => {
    storageMock.getDevis.mockRejectedValue(new Error("DB blew up"));

    await expect(persistSignedDevisPdf(42)).resolves.toBeUndefined();
  });
});
