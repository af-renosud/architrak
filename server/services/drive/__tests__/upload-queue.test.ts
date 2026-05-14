import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DriveUpload } from "@shared/schema";

vi.mock("../../../storage", () => ({
  storage: {
    upsertDriveUpload: vi.fn(),
    enqueueDriveUpload: vi.fn(),
    claimDriveUploadForAttempt: vi.fn(),
    markDriveUploadSucceeded: vi.fn(),
    markDriveUploadDeadLettered: vi.fn(),
    markDriveUploadPendingRetry: vi.fn(),
    reclaimStaleDriveUploads: vi.fn(),
    listDueDriveUploads: vi.fn(),
    setDevisDriveLink: vi.fn(),
    setInvoiceDriveLink: vi.fn(),
    setCertificatDriveLink: vi.fn(),
  },
}));

vi.mock("../../../env", () => ({
  env: { DRIVE_AUTO_UPLOAD_ENABLED: false },
}));

vi.mock("../client", () => ({
  isDriveAutoUploadEnabled: vi.fn(() => true),
  isTransientDriveError: vi.fn(),
}));

vi.mock("../lot-folder.service", () => ({
  ensureLotFolder: vi.fn(),
}));

vi.mock("../upload.service", () => ({
  uploadPdfToFolder: vi.fn(),
}));

import {
  enqueueDriveUpload,
  attemptDriveUpload,
  sweepPendingDriveUploads,
  MAX_DRIVE_UPLOAD_ATTEMPTS,
} from "../upload-queue.service";
import { storage } from "../../../storage";
import { isDriveAutoUploadEnabled, isTransientDriveError } from "../client";
import { ensureLotFolder } from "../lot-folder.service";
import { uploadPdfToFolder } from "../upload.service";

const mockedStorage = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedFlag = isDriveAutoUploadEnabled as unknown as ReturnType<typeof vi.fn>;
const mockedTransient = isTransientDriveError as unknown as ReturnType<typeof vi.fn>;
const mockedEnsureLotFolder = ensureLotFolder as unknown as ReturnType<typeof vi.fn>;
const mockedUploadPdfToFolder = uploadPdfToFolder as unknown as ReturnType<typeof vi.fn>;

function makeRow(overrides: Partial<DriveUpload> = {}): DriveUpload {
  return {
    id: 1,
    docKind: "devis",
    docId: 10,
    projectId: 100,
    lotId: 200,
    sourceStorageKey: "key/devis-10.pdf",
    displayName: "DEV-001.pdf",
    state: "pending",
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    nextAttemptAt: new Date(),
    driveFileId: null,
    driveWebViewLink: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DriveUpload;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFlag.mockReturnValue(true);
});

describe("enqueueDriveUpload — feature flag short-circuit", () => {
  it("is a silent no-op when DRIVE_AUTO_UPLOAD_ENABLED=false", async () => {
    mockedFlag.mockReturnValue(false);
    await enqueueDriveUpload({
      docKind: "devis",
      docId: 1,
      projectId: 1,
      lotId: null,
      sourceStorageKey: "key",
      displayName: "x.pdf",
      seedDevisCode: "D-001",
    });
    expect(mockedStorage.upsertDriveUpload).not.toHaveBeenCalled();
  });

  it("accepts the gmail-scrape doc_kind extension (0033)", async () => {
    mockedFlag.mockReturnValue(false);
    await enqueueDriveUpload({
      docKind: "scrape",
      docId: 99,
      projectId: 1,
      lotId: null,
      sourceStorageKey: "key",
      displayName: "scraped.pdf",
      seedDevisCode: "scrape-99",
    });
    expect(mockedStorage.upsertDriveUpload).not.toHaveBeenCalled();
  });
});

describe("enqueueDriveUpload — idempotent on already-succeeded row", () => {
  it("does NOT trigger a fresh attempt when upsert returns an existing succeeded row", async () => {
    // Simulate ON CONFLICT DO NOTHING returning the existing row untouched.
    mockedStorage.upsertDriveUpload.mockResolvedValue(
      makeRow({ state: "succeeded", attempts: 1, driveFileId: "FID", driveWebViewLink: "link" }),
    );

    await enqueueDriveUpload({
      docKind: "devis",
      docId: 10,
      projectId: 100,
      lotId: 200,
      sourceStorageKey: "key/devis-10.pdf",
      displayName: "DEV-001.pdf",
      seedDevisCode: "DEV-001",
    });

    // The inline first attempt MUST NOT fire — that would risk a
    // duplicate Drive file.
    expect(mockedStorage.claimDriveUploadForAttempt).not.toHaveBeenCalled();
    expect(mockedStorage.markDriveUploadSucceeded).not.toHaveBeenCalled();
    expect(mockedStorage.markDriveUploadPendingRetry).not.toHaveBeenCalled();
    expect(mockedStorage.markDriveUploadDeadLettered).not.toHaveBeenCalled();
  });

  it("does NOT trigger a fresh attempt when upsert returns an existing dead-lettered row", async () => {
    mockedStorage.upsertDriveUpload.mockResolvedValue(
      makeRow({ state: "dead_letter", attempts: 5 }),
    );

    await enqueueDriveUpload({
      docKind: "devis",
      docId: 10,
      projectId: 100,
      lotId: 200,
      sourceStorageKey: "key/devis-10.pdf",
      displayName: "DEV-001.pdf",
      seedDevisCode: "DEV-001",
    });

    expect(mockedStorage.claimDriveUploadForAttempt).not.toHaveBeenCalled();
  });
});

describe("attemptDriveUpload — state transitions", () => {
  it("pending → succeeded on a successful upload, and writes back to source row", async () => {
    mockedStorage.claimDriveUploadForAttempt.mockResolvedValue(
      makeRow({ state: "in_flight", attempts: 0 }),
    );
    mockedEnsureLotFolder.mockResolvedValue("FOLDER-ID");
    mockedUploadPdfToFolder.mockResolvedValue({ fileId: "FILE-1", webViewLink: "https://drive/1" });

    await attemptDriveUpload(1);

    expect(mockedEnsureLotFolder).toHaveBeenCalledWith({
      projectId: 100,
      lotId: 200,
      seedDevisCode: "DEV-001",
    });
    expect(mockedUploadPdfToFolder).toHaveBeenCalledWith(
      "FOLDER-ID",
      "DEV-001.pdf",
      "key/devis-10.pdf",
    );
    expect(mockedStorage.markDriveUploadSucceeded).toHaveBeenCalledWith({
      uploadId: 1,
      attempts: 1,
      driveFileId: "FILE-1",
      driveWebViewLink: "https://drive/1",
    });
    expect(mockedStorage.setDevisDriveLink).toHaveBeenCalledWith(10, "FILE-1", "https://drive/1");
    expect(mockedStorage.markDriveUploadPendingRetry).not.toHaveBeenCalled();
    expect(mockedStorage.markDriveUploadDeadLettered).not.toHaveBeenCalled();
  });

  it("pending → pending-retry with incremented attempts on a transient failure", async () => {
    mockedStorage.claimDriveUploadForAttempt.mockResolvedValue(
      makeRow({ state: "in_flight", attempts: 0 }),
    );
    mockedEnsureLotFolder.mockResolvedValue("FOLDER-ID");
    const transientErr = Object.assign(new Error("network blip"), { code: 503 });
    mockedUploadPdfToFolder.mockRejectedValue(transientErr);
    mockedTransient.mockReturnValue(true);

    await attemptDriveUpload(1);

    expect(mockedStorage.markDriveUploadPendingRetry).toHaveBeenCalledTimes(1);
    const call = mockedStorage.markDriveUploadPendingRetry.mock.calls[0][0] as {
      uploadId: number;
      attempts: number;
      lastError: string;
      nextAttemptAt: Date;
    };
    expect(call.uploadId).toBe(1);
    expect(call.attempts).toBe(1);
    expect(call.lastError).toContain("network blip");
    expect(call.nextAttemptAt).toBeInstanceOf(Date);
    expect(call.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(mockedStorage.markDriveUploadSucceeded).not.toHaveBeenCalled();
    expect(mockedStorage.markDriveUploadDeadLettered).not.toHaveBeenCalled();
  });

  it("pending → dead_letter immediately on a permanent (non-transient) failure", async () => {
    mockedStorage.claimDriveUploadForAttempt.mockResolvedValue(
      makeRow({ state: "in_flight", attempts: 0 }),
    );
    mockedEnsureLotFolder.mockResolvedValue("FOLDER-ID");
    mockedUploadPdfToFolder.mockRejectedValue(new Error("permission denied"));
    mockedTransient.mockReturnValue(false);

    await attemptDriveUpload(1);

    expect(mockedStorage.markDriveUploadDeadLettered).toHaveBeenCalledWith({
      uploadId: 1,
      attempts: 1,
      lastError: expect.stringContaining("permission denied"),
    });
    expect(mockedStorage.markDriveUploadPendingRetry).not.toHaveBeenCalled();
  });

  it("dead-letters once attempts exhaust MAX_DRIVE_UPLOAD_ATTEMPTS even for transient errors", async () => {
    mockedStorage.claimDriveUploadForAttempt.mockResolvedValue(
      makeRow({ state: "in_flight", attempts: MAX_DRIVE_UPLOAD_ATTEMPTS - 1 }),
    );
    mockedEnsureLotFolder.mockResolvedValue("FOLDER-ID");
    mockedUploadPdfToFolder.mockRejectedValue(new Error("ECONNRESET"));
    mockedTransient.mockReturnValue(true);

    await attemptDriveUpload(1);

    expect(mockedStorage.markDriveUploadDeadLettered).toHaveBeenCalledWith({
      uploadId: 1,
      attempts: MAX_DRIVE_UPLOAD_ATTEMPTS,
      lastError: expect.stringContaining("ECONNRESET"),
    });
    expect(mockedStorage.markDriveUploadPendingRetry).not.toHaveBeenCalled();
  });

  it("is a no-op when claim returns null (row already taken / done)", async () => {
    mockedStorage.claimDriveUploadForAttempt.mockResolvedValue(null);

    await attemptDriveUpload(1);

    expect(mockedEnsureLotFolder).not.toHaveBeenCalled();
    expect(mockedUploadPdfToFolder).not.toHaveBeenCalled();
    expect(mockedStorage.markDriveUploadSucceeded).not.toHaveBeenCalled();
    expect(mockedStorage.markDriveUploadPendingRetry).not.toHaveBeenCalled();
    expect(mockedStorage.markDriveUploadDeadLettered).not.toHaveBeenCalled();
  });

  it("routes the writeback to the invoice table when docKind=invoice", async () => {
    mockedStorage.claimDriveUploadForAttempt.mockResolvedValue(
      makeRow({ docKind: "invoice", docId: 42, state: "in_flight" }),
    );
    mockedEnsureLotFolder.mockResolvedValue("FOLDER-ID");
    mockedUploadPdfToFolder.mockResolvedValue({ fileId: "FID", webViewLink: "L" });

    await attemptDriveUpload(1);

    expect(mockedStorage.setInvoiceDriveLink).toHaveBeenCalledWith(42, "FID", "L");
    expect(mockedStorage.setDevisDriveLink).not.toHaveBeenCalled();
    expect(mockedStorage.setCertificatDriveLink).not.toHaveBeenCalled();
  });

  it("does NOT call any writeback for docKind=scrape (project_documents has no drive_link column)", async () => {
    mockedStorage.claimDriveUploadForAttempt.mockResolvedValue(
      makeRow({ docKind: "scrape", docId: 77, state: "in_flight" }),
    );
    mockedEnsureLotFolder.mockResolvedValue("FOLDER-ID");
    mockedUploadPdfToFolder.mockResolvedValue({ fileId: "FID", webViewLink: "L" });

    await attemptDriveUpload(1);

    expect(mockedStorage.markDriveUploadSucceeded).toHaveBeenCalled();
    expect(mockedStorage.setDevisDriveLink).not.toHaveBeenCalled();
    expect(mockedStorage.setInvoiceDriveLink).not.toHaveBeenCalled();
    expect(mockedStorage.setCertificatDriveLink).not.toHaveBeenCalled();
  });
});

describe("sweepPendingDriveUploads — reclaims stale in_flight rows", () => {
  it("calls reclaimStaleDriveUploads BEFORE listDueDriveUploads so reclaimed rows are picked up in the same tick", async () => {
    const order: string[] = [];
    mockedStorage.reclaimStaleDriveUploads.mockImplementation(async () => {
      order.push("reclaim");
      return 2;
    });
    mockedStorage.listDueDriveUploads.mockImplementation(async () => {
      order.push("list");
      return [];
    });

    await sweepPendingDriveUploads();

    expect(order).toEqual(["reclaim", "list"]);
    // Lease window matches the published constant (10 minutes).
    expect(mockedStorage.reclaimStaleDriveUploads).toHaveBeenCalledWith(10 * 60 * 1000);
  });

  it("dispatches an attempt for each due row returned by listDueDriveUploads", async () => {
    mockedStorage.reclaimStaleDriveUploads.mockResolvedValue(0);
    mockedStorage.listDueDriveUploads.mockResolvedValue([
      makeRow({ id: 11 }),
      makeRow({ id: 22 }),
    ]);
    // Both claims return null so no actual work happens — we're just
    // verifying dispatch fan-out.
    mockedStorage.claimDriveUploadForAttempt.mockResolvedValue(null);

    await sweepPendingDriveUploads();

    expect(mockedStorage.claimDriveUploadForAttempt).toHaveBeenCalledTimes(2);
    expect(mockedStorage.claimDriveUploadForAttempt).toHaveBeenNthCalledWith(1, 11);
    expect(mockedStorage.claimDriveUploadForAttempt).toHaveBeenNthCalledWith(2, 22);
  });

  it("is a silent no-op when the feature flag is off", async () => {
    mockedFlag.mockReturnValue(false);

    await sweepPendingDriveUploads();

    expect(mockedStorage.reclaimStaleDriveUploads).not.toHaveBeenCalled();
    expect(mockedStorage.listDueDriveUploads).not.toHaveBeenCalled();
  });
});
