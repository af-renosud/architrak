import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../client", () => ({
  getDriveConfig: vi.fn(),
}));

import {
  normaliseFolderName,
  locateProjectDevisRootFolder,
  DriveFolderNotFoundError,
} from "../folder-locator";
import { getDriveConfig } from "../client";

const mockedGetDriveConfig = getDriveConfig as unknown as ReturnType<typeof vi.fn>;

interface FakeFile {
  id: string;
  name: string;
}

/**
 * Builds a fake googleapis Drive client whose `files.list` returns a
 * different set of children depending on which `parentFolderId` (`q`)
 * is being queried. Pages are not exercised — each level returns a
 * single page.
 */
function makeFakeClient(byParent: Record<string, FakeFile[]>) {
  return {
    files: {
      list: vi.fn(async (args: { q: string }) => {
        const match = args.q.match(/^'([^']+)' in parents/);
        const parent = match ? match[1] : "";
        const files = byParent[parent] ?? [];
        return { data: { files, nextPageToken: undefined } };
      }),
    },
  };
}

describe("normaliseFolderName (Task #198 strict project-folder match)", () => {
  it("collapses case + accents + whitespace", () => {
    expect(normaliseFolderName("Smith House")).toBe(normaliseFolderName("SMITH  house"));
    expect(normaliseFolderName("Château Léon")).toBe(normaliseFolderName("chateau leon"));
  });

  it("treats different projects as different even when they share a prefix", () => {
    expect(normaliseFolderName("Smith House")).not.toBe(normaliseFolderName("Smith House Pool"));
  });

  it("never returns empty string for non-empty input", () => {
    expect(normaliseFolderName("X")).toBe("x");
  });
});

describe("locateProjectDevisRootFolder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws DriveFolderNotFoundError when multiple top-level folders match the project name (case/accent-insensitive)", async () => {
    const client = makeFakeClient({
      DRIVE: [
        { id: "p1", name: "Smith House" },
        { id: "p2", name: "smith  house" }, // duplicates after normalisation
        { id: "p3", name: "Smith House Pool" }, // different project — must NOT confuse the matcher
      ],
    });
    mockedGetDriveConfig.mockReturnValue({ client, sharedDriveId: "DRIVE" });

    await expect(locateProjectDevisRootFolder("Smith House")).rejects.toBeInstanceOf(
      DriveFolderNotFoundError,
    );
    await expect(locateProjectDevisRootFolder("Smith House")).rejects.toThrow(/Ambiguous/i);
  });

  it("throws DriveFolderNotFoundError when no top-level folder matches the project name", async () => {
    const client = makeFakeClient({
      DRIVE: [{ id: "px", name: "Some Other Project" }],
    });
    mockedGetDriveConfig.mockReturnValue({ client, sharedDriveId: "DRIVE" });

    await expect(locateProjectDevisRootFolder("Smith House")).rejects.toBeInstanceOf(
      DriveFolderNotFoundError,
    );
  });

  it("does NOT fall back to startsWith / includes — sibling 'Smith House Pool' is not accepted as a match for 'Smith House'", async () => {
    const client = makeFakeClient({
      DRIVE: [{ id: "p3", name: "Smith House Pool" }],
    });
    mockedGetDriveConfig.mockReturnValue({ client, sharedDriveId: "DRIVE" });

    // The strict-match policy forbids prefix/substring fallback —
    // a typo or near-match should dead-letter, not silently route
    // documents into the wrong client folder.
    await expect(locateProjectDevisRootFolder("Smith House")).rejects.toBeInstanceOf(
      DriveFolderNotFoundError,
    );
  });

  it("walks the full FINANCIAL/LIVE PROJECT FINANCIAL/1 DEVIS & FACTURE FOLDERS path on a happy match", async () => {
    const client = makeFakeClient({
      DRIVE: [{ id: "PROJ", name: "Smith House" }],
      PROJ: [{ id: "FIN", name: "FINANCIAL" }],
      FIN: [{ id: "LIVE", name: "LIVE PROJECT FINANCIAL" }],
      LIVE: [{ id: "ROOT", name: "1 DEVIS & FACTURE FOLDERS" }],
    });
    mockedGetDriveConfig.mockReturnValue({ client, sharedDriveId: "DRIVE" });

    const id = await locateProjectDevisRootFolder("smith  house"); // accent/case-insensitive
    expect(id).toBe("ROOT");
  });

  it("throws DriveFolderNotFoundError when an intermediate Renosud folder is missing", async () => {
    const client = makeFakeClient({
      DRIVE: [{ id: "PROJ", name: "Smith House" }],
      PROJ: [{ id: "FIN", name: "FINANCIAL" }],
      FIN: [], // missing LIVE PROJECT FINANCIAL
    });
    mockedGetDriveConfig.mockReturnValue({ client, sharedDriveId: "DRIVE" });

    await expect(locateProjectDevisRootFolder("Smith House")).rejects.toBeInstanceOf(
      DriveFolderNotFoundError,
    );
  });
});
