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
    recordSignedPdfPersistFailure: vi.fn(async () => {}),
    armSignedPdfPersistRetry: vi.fn(async () => {}),
    clearSignedPdfRetry: vi.fn(async () => {}),
    listDueSignedPdfRetries: vi.fn(async () => [] as Array<{ id: number }>),
  },
  archisignMock: {
    getSignedPdfUrl: vi.fn(),
  },
  uploadMock: {
    uploadDocumentAtKey: vi.fn(async (objectName: string, _buf: Buffer) => `/bucket/${objectName}`),
    buildSignedDevisObjectName: vi.fn(
      (projectId: number, devisId: number) =>
        `private/projects/${projectId}/documents/devis-signed/${devisId}.pdf`,
    ),
  },
  driveQueueMock: {
    enqueueDriveUpload: vi.fn(async () => undefined),
  },
}));

vi.mock("../../storage", () => ({ storage: storageMock }));
vi.mock("../archisign.js", () => {
  // Mirror the real class hierarchy so `instanceof` checks inside the
  // service still resolve correctly without dragging the real Archisign
  // HTTP client into the test.
  class ArchisignError extends Error {
    constructor(
      message: string,
      public readonly httpStatus: number,
      public readonly responseBody?: unknown,
      public readonly isTransient: boolean = false,
    ) {
      super(message);
      this.name = "ArchisignError";
    }
  }
  class ArchisignConfigError extends ArchisignError {
    constructor(message: string) {
      super(message, 503, undefined, true);
      this.name = "ArchisignConfigError";
    }
  }
  class ArchisignRetentionBreachError extends ArchisignError {
    constructor(public breach: { incidentRef: string }) {
      super("retention breach", 410);
    }
  }
  return {
    getSignedPdfUrl: archisignMock.getSignedPdfUrl,
    ArchisignError,
    ArchisignConfigError,
    ArchisignRetentionBreachError,
  };
});
vi.mock("../../storage/object-storage", () => ({
  uploadDocumentAtKey: uploadMock.uploadDocumentAtKey,
  buildSignedDevisObjectName: uploadMock.buildSignedDevisObjectName,
}));
vi.mock("../drive/upload-queue.service", () => ({ enqueueDriveUpload: driveQueueMock.enqueueDriveUpload }));

import { persistSignedDevisPdf, signedPdfFileName } from "../devis-signed-pdf.service";
import {
  ArchisignError,
  ArchisignConfigError,
  ArchisignRetentionBreachError,
} from "../archisign.js";

const baseDevis = {
  id: 42,
  projectId: 7,
  lotId: 3,
  devisCode: "DEV-2026-014",
  archisignEnvelopeId: "env_abc",
  signedPdfFetchUrlSnapshot: "https://archisign.test/snap.pdf",
  signedPdfStorageKey: null as string | null,
  signedPdfRetryAttempts: 0,
  signedPdfNextAttemptAt: null as Date | null,
  signedPdfLastError: null as string | null,
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
    storageMock.recordSignedPdfPersistFailure.mockReset();
    storageMock.clearSignedPdfRetry.mockReset();
    archisignMock.getSignedPdfUrl.mockReset();
    uploadMock.uploadDocumentAtKey.mockReset();
    uploadMock.uploadDocumentAtKey.mockResolvedValue("/bucket/private/projects/7/documents/devis-signed/42.pdf");
    uploadMock.buildSignedDevisObjectName.mockReset();
    uploadMock.buildSignedDevisObjectName.mockImplementation(
      (projectId: number, devisId: number) =>
        `private/projects/${projectId}/documents/devis-signed/${devisId}.pdf`,
    );
    driveQueueMock.enqueueDriveUpload.mockReset();
  });

  it("downloads via the snapshot URL, persists locally, and enqueues the Drive mirror with `devis_signed`", async () => {
    storageMock.getDevis.mockResolvedValue({ ...baseDevis });
    mockFetchOk();

    await persistSignedDevisPdf(42);

    expect(global.fetch).toHaveBeenCalledWith(baseDevis.signedPdfFetchUrlSnapshot, expect.anything());
    expect(archisignMock.getSignedPdfUrl).not.toHaveBeenCalled();
    // Deterministic key: one devis → one stable object name (no
    // timestamp). Concurrent webhook replays / sweeper retries collapse
    // onto this same path so we cannot accumulate duplicate artifacts.
    expect(uploadMock.buildSignedDevisObjectName).toHaveBeenCalledWith(7, 42);
    expect(uploadMock.uploadDocumentAtKey).toHaveBeenCalledWith(
      "private/projects/7/documents/devis-signed/42.pdf",
      expect.any(Buffer),
      "application/pdf",
    );
    expect(storageMock.setDevisSignedPdfStorageKey).toHaveBeenCalledWith(
      42,
      "/bucket/private/projects/7/documents/devis-signed/42.pdf",
    );
    expect(driveQueueMock.enqueueDriveUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        docKind: "devis_signed",
        docId: 42,
        projectId: 7,
        lotId: 3,
        sourceStorageKey: "/bucket/private/projects/7/documents/devis-signed/42.pdf",
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
    expect(uploadMock.uploadDocumentAtKey).toHaveBeenCalledTimes(1);
    expect(driveQueueMock.enqueueDriveUpload).toHaveBeenCalledTimes(1);
  });

  it("skips persistence (and Drive enqueue) when re-mint reports an Archisign retention breach, and marks the retry as terminal (nextAttemptAt=null)", async () => {
    storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
    archisignMock.getSignedPdfUrl.mockRejectedValue(
      new ArchisignRetentionBreachError({ incidentRef: "inc_123" } as never),
    );

    await persistSignedDevisPdf(42);

    expect(uploadMock.uploadDocumentAtKey).not.toHaveBeenCalled();
    expect(storageMock.setDevisSignedPdfStorageKey).not.toHaveBeenCalled();
    expect(driveQueueMock.enqueueDriveUpload).not.toHaveBeenCalled();
    expect(storageMock.recordSignedPdfPersistFailure).toHaveBeenCalledWith(
      42,
      expect.stringContaining("retention breach"),
      null,
    );
  });

  it("two concurrent persist runs for the same devis upload to the SAME deterministic key (no duplicate physical artifacts on race/replay)", async () => {
    storageMock.getDevis.mockResolvedValue({ ...baseDevis });
    mockFetchOk();

    await Promise.all([persistSignedDevisPdf(42), persistSignedDevisPdf(42)]);

    // Both calls compute the same deterministic object name and write
    // to it; idempotent overwrite means a single physical artifact.
    const keysUploaded = uploadMock.uploadDocumentAtKey.mock.calls.map((c) => c[0]);
    const uniqueKeys = new Set(keysUploaded);
    expect(uniqueKeys.size).toBe(1);
    expect([...uniqueKeys][0]).toBe("private/projects/7/documents/devis-signed/42.pdf");
  });

  it("sweepDueSignedPdfRetries delegates to persistSignedDevisPdf for each row returned by storage and is bounded by what storage decides is due", async () => {
    const { sweepDueSignedPdfRetries } = await import("../devis-signed-pdf.service");
    storageMock.listDueSignedPdfRetries.mockResolvedValueOnce([{ id: 11 }, { id: 22 }]);
    // Force getDevis to short-circuit so we just observe the dispatch.
    storageMock.getDevis.mockResolvedValue(null);

    await sweepDueSignedPdfRetries();

    expect(storageMock.listDueSignedPdfRetries).toHaveBeenCalledWith(20);
    expect(storageMock.getDevis).toHaveBeenCalledWith(11);
    expect(storageMock.getDevis).toHaveBeenCalledWith(22);
    // Eligibility is enforced by SQL inside listDueSignedPdfRetries
    // (NOT NULL next_attempt_at + attempts < MAX). The sweeper trusts
    // that filter and never picks up rows storage has not yielded.
    expect(storageMock.getDevis).toHaveBeenCalledTimes(2);
  });

  it("schedules a retry with exponential backoff when a transient download failure occurs", async () => {
    storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
    archisignMock.getSignedPdfUrl.mockRejectedValue(new Error("upstream 503"));

    await persistSignedDevisPdf(42);

    expect(storageMock.recordSignedPdfPersistFailure).toHaveBeenCalledTimes(1);
    const [, message, nextAt] = storageMock.recordSignedPdfPersistFailure.mock.calls[0];
    expect(message).toMatch(/upstream 503/);
    expect(nextAt).toBeInstanceOf(Date);
    expect((nextAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("is idempotent: when signedPdfStorageKey already exists, skips the download but still ensures the Drive enqueue", async () => {
    storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfStorageKey: "existing/key.pdf" });
    global.fetch = vi.fn() as unknown as typeof fetch;

    await persistSignedDevisPdf(42);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(uploadMock.uploadDocumentAtKey).not.toHaveBeenCalled();
    expect(storageMock.setDevisSignedPdfStorageKey).not.toHaveBeenCalled();
    expect(driveQueueMock.enqueueDriveUpload).toHaveBeenCalledWith(
      expect.objectContaining({ docKind: "devis_signed", sourceStorageKey: "existing/key.pdf" }),
    );
  });

  it("never throws on unexpected failures (best-effort contract — webhook handler must keep its 200 response)", async () => {
    storageMock.getDevis.mockRejectedValue(new Error("DB blew up"));

    await expect(persistSignedDevisPdf(42)).resolves.toEqual(
      expect.objectContaining({ persisted: false, failureKind: "other" }),
    );
  });

  // -------------------------------------------------------------------
  // Task #438 — outcome classification so operator-facing callers can
  // show "Archisign temporarily down, retry" instead of a generic error.
  // -------------------------------------------------------------------
  describe("outcome classification (Task #438)", () => {
    it("classifies an upstream 5xx from getSignedPdfUrl as archisign_unavailable (retry stays armed)", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
      archisignMock.getSignedPdfUrl.mockRejectedValue(
        new ArchisignError("Archisign 503: Service Unavailable", 503, undefined, true),
      );

      const outcome = await persistSignedDevisPdf(42);

      expect(outcome).toEqual({
        persisted: false,
        failureKind: "archisign_unavailable",
        error: "Archisign 503: Service Unavailable",
      });
      // The transient failure still arms the sweeper retry.
      const [, , nextAt] = storageMock.recordSignedPdfPersistFailure.mock.calls[0];
      expect(nextAt).toBeInstanceOf(Date);
    });

    it("classifies exhausted timeouts / network errors (httpStatus 0) as archisign_unavailable", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
      archisignMock.getSignedPdfUrl.mockRejectedValue(
        new ArchisignError("Archisign network error after retries: fetch failed", 0, undefined, true),
      );

      const outcome = await persistSignedDevisPdf(42);

      expect(outcome.persisted).toBe(false);
      expect(outcome.failureKind).toBe("archisign_unavailable");
    });

    it("classifies a local config problem as archisign_unconfigured, NOT unavailable", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
      archisignMock.getSignedPdfUrl.mockRejectedValue(
        new ArchisignConfigError("ARCHISIGN_API_KEY is not configured"),
      );

      const outcome = await persistSignedDevisPdf(42);

      expect(outcome.failureKind).toBe("archisign_unconfigured");
    });

    it("classifies a retention breach as retention_breach (terminal)", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
      archisignMock.getSignedPdfUrl.mockRejectedValue(
        new ArchisignRetentionBreachError({ incidentRef: "inc_123" } as never),
      );

      const outcome = await persistSignedDevisPdf(42);

      expect(outcome.failureKind).toBe("retention_breach");
    });

    it("classifies a 5xx on the reminted signed-PDF byte download as archisign_unavailable", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
      archisignMock.getSignedPdfUrl.mockResolvedValue({ url: "https://archisign.test/reminted.pdf" });
      mockFetchFail(503);

      const outcome = await persistSignedDevisPdf(42);

      expect(outcome.persisted).toBe(false);
      expect(outcome.failureKind).toBe("archisign_unavailable");
      expect(outcome.error).toMatch(/HTTP 503/);
      // Transient — the sweeper retry stays armed.
      const [, , nextAt] = storageMock.recordSignedPdfPersistFailure.mock.calls[0];
      expect(nextAt).toBeInstanceOf(Date);
    });

    it("classifies a network failure on the signed-PDF byte download as archisign_unavailable", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
      archisignMock.getSignedPdfUrl.mockResolvedValue({ url: "https://archisign.test/reminted.pdf" });
      global.fetch = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;

      const outcome = await persistSignedDevisPdf(42);

      expect(outcome.failureKind).toBe("archisign_unavailable");
      expect(outcome.error).toMatch(/fetch failed/);
    });

    it("classifies a 4xx on the signed-PDF byte download as other (retry alone will not help)", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
      archisignMock.getSignedPdfUrl.mockResolvedValue({ url: "https://archisign.test/reminted.pdf" });
      mockFetchFail(404);

      const outcome = await persistSignedDevisPdf(42);

      expect(outcome.failureKind).toBe("other");
    });

    it("does NOT misclassify a storage upload failure as an Archisign outage", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis });
      mockFetchOk();
      uploadMock.uploadDocumentAtKey.mockRejectedValueOnce(new Error("object storage unreachable"));

      const outcome = await persistSignedDevisPdf(42);

      expect(outcome.persisted).toBe(false);
      expect(outcome.failureKind).toBe("other");
      expect(outcome.error).toMatch(/object storage unreachable/);
    });

    it("classifies an Archisign 4xx as other (a retry will not help by itself)", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis, signedPdfFetchUrlSnapshot: null });
      archisignMock.getSignedPdfUrl.mockRejectedValue(
        new ArchisignError("Archisign 404: envelope not found", 404, undefined, false),
      );

      const outcome = await persistSignedDevisPdf(42);

      expect(outcome.failureKind).toBe("other");
    });

    it("returns { persisted: true } on the happy path", async () => {
      storageMock.getDevis.mockResolvedValue({ ...baseDevis });
      mockFetchOk();

      await expect(persistSignedDevisPdf(42)).resolves.toEqual({ persisted: true });
    });
  });
});
