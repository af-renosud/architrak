import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../storage", () => ({
  storage: {
    enqueueDriveUpload: vi.fn(),
  },
}));

vi.mock("../../../env", () => ({
  env: { DRIVE_AUTO_UPLOAD_ENABLED: false },
}));

import { enqueueDriveUpload } from "../upload-queue.service";
import { storage } from "../../../storage";

describe("enqueueDriveUpload (Task #198)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is a silent no-op when DRIVE_AUTO_UPLOAD_ENABLED=false", async () => {
    await enqueueDriveUpload({
      docKind: "devis",
      docId: 1,
      projectId: 1,
      lotId: null,
      sourceStorageKey: "key",
      displayName: "x.pdf",
      seedDevisCode: "D-001",
    });
    expect(storage.enqueueDriveUpload).not.toHaveBeenCalled();
  });

  it("accepts the gmail-scrape doc_kind extension (0033)", async () => {
    // Compile-time check: the new "scrape" kind is in the union.
    const input = {
      docKind: "scrape" as const,
      docId: 99,
      projectId: 1,
      lotId: null,
      sourceStorageKey: "key",
      displayName: "scraped.pdf",
      seedDevisCode: "scrape-99",
    };
    await enqueueDriveUpload(input);
    // Still a no-op since the flag is off, but the call type-checks.
    expect(storage.enqueueDriveUpload).not.toHaveBeenCalled();
  });
});
