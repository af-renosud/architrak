import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { Readable } from "stream";

vi.mock("../../env", () => ({
  env: {
    DEFAULT_OBJECT_STORAGE_BUCKET_ID: "test-bucket",
    PRIVATE_OBJECT_DIR: "/test-bucket/.private",
    DOCRAPTOR_API_KEY: "test-docraptor-key",
    GEMINI_API_KEY: "test-gemini",
    AI_INTEGRATIONS_OPENAI_API_KEY: "test-openai",
  },
}));

vi.mock("../../storage", () => ({
  storage: {
    getDevis: vi.fn(),
    getDevisTranslation: vi.fn(),
    updateDevisTranslation: vi.fn(),
  },
}));

vi.mock("../../storage/object-storage", () => ({
  getDocumentStream: vi.fn(),
  uploadDocument: vi.fn(),
  getDocumentBuffer: vi.fn(),
}));

vi.mock("../../communications/devis-translation-generator", () => ({
  generateDevisTranslationPdf: vi.fn(),
  generateCombinedPdf: vi.fn(),
}));

vi.mock("../../services/devis-translation", () => ({
  translateDevis: vi.fn(),
  retranslateSingleLine: vi.fn(),
}));

import devisRouter from "../devis";
import { storage } from "../../storage";
import { getDocumentStream } from "../../storage/object-storage";
import {
  generateDevisTranslationPdf,
  generateCombinedPdf,
} from "../../communications/devis-translation-generator";

const getDevis = storage.getDevis as unknown as ReturnType<typeof vi.fn>;
const getDevisTranslation = storage.getDevisTranslation as unknown as ReturnType<typeof vi.fn>;
const updateDevisTranslation = storage.updateDevisTranslation as unknown as ReturnType<typeof vi.fn>;
const getDocumentStreamMock = getDocumentStream as unknown as ReturnType<typeof vi.fn>;
const generateDevisTranslationPdfMock = generateDevisTranslationPdf as unknown as ReturnType<typeof vi.fn>;
const generateCombinedPdfMock = generateCombinedPdf as unknown as ReturnType<typeof vi.fn>;

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(devisRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ message });
  });
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
  getDocumentStreamMock.mockResolvedValue({
    stream: Readable.from(["pdf-bytes"]),
    contentType: "application/pdf",
    size: 9,
  });
});

describe("GET /api/devis/:id/pdf?variant=...", () => {
  it("streams the original PDF when variant=original", async () => {
    getDevis.mockResolvedValue({
      id: 1,
      devisCode: "D-1",
      pdfFileName: "devis-1.pdf",
      pdfStorageKey: "k/original.pdf",
    });

    const res = await fetch(`${baseUrl}/api/devis/1/pdf?variant=original`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(getDocumentStreamMock).toHaveBeenCalledWith("k/original.pdf");
    expect(generateDevisTranslationPdfMock).not.toHaveBeenCalled();
  });

  it("returns the cached translation PDF when variant=translation and translation is ready", async () => {
    getDevis.mockResolvedValue({ id: 2, devisCode: "D-2", pdfStorageKey: "k/orig" });
    getDevisTranslation.mockResolvedValue({
      status: "draft",
      translatedPdfStorageKey: "k/translated.pdf",
      combinedPdfStorageKey: null,
    });

    const res = await fetch(`${baseUrl}/api/devis/2/pdf?variant=translation`);
    expect(res.status).toBe(200);
    expect(getDocumentStreamMock).toHaveBeenCalledWith("k/translated.pdf");
    // Cached key was used: PDF generator must NOT have been called.
    expect(generateDevisTranslationPdfMock).not.toHaveBeenCalled();
  });

  it("regenerates and streams the combined PDF when variant=combined", async () => {
    getDevis.mockResolvedValue({ id: 3, devisCode: "D-3", pdfStorageKey: "k/orig" });
    getDevisTranslation.mockResolvedValue({
      status: "draft",
      translatedPdfStorageKey: "k/translated",
      combinedPdfStorageKey: null,
    });
    generateCombinedPdfMock.mockResolvedValue({
      storageKey: "k/combined.pdf",
      pdfBuffer: Buffer.from("ignored"),
    });

    const res = await fetch(`${baseUrl}/api/devis/3/pdf?variant=combined`);
    expect(res.status).toBe(200);
    expect(generateCombinedPdfMock).toHaveBeenCalledWith(3, { includeExplanations: false });
    expect(getDocumentStreamMock).toHaveBeenCalledWith("k/combined.pdf");
  });

  it("returns 409 when variant=translation but translation is not ready", async () => {
    getDevis.mockResolvedValue({ id: 4, devisCode: "D-4", pdfStorageKey: "k/orig" });
    getDevisTranslation.mockResolvedValue({ status: "processing" });

    const res = await fetch(`${baseUrl}/api/devis/4/pdf?variant=translation`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ status: "processing" });
    expect(generateDevisTranslationPdfMock).not.toHaveBeenCalled();
  });

  it("returns 409 when variant=combined but translation is missing", async () => {
    getDevis.mockResolvedValue({ id: 5, devisCode: "D-5", pdfStorageKey: "k/orig" });
    getDevisTranslation.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/devis/5/pdf?variant=combined`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ status: "missing" });
  });
});

describe("PATCH /api/devis/:id/translation", () => {
  it("clears cached PDF storage keys, marks the row as edited, and flags user-changed lines", async () => {
    getDevisTranslation.mockResolvedValue({
      status: "draft",
      headerTranslated: { description: "Old header" },
      lineTranslations: [
        { lineNumber: 1, originalDescription: "x", translation: "Old en 1", edited: false },
        { lineNumber: 2, originalDescription: "y", translation: "Old en 2", edited: false },
      ],
      translatedPdfStorageKey: "k/cached-translated.pdf",
      combinedPdfStorageKey: "k/cached-combined.pdf",
    });
    updateDevisTranslation.mockImplementation(async (_id: number, patch: Record<string, unknown>) => patch);

    const res = await fetch(`${baseUrl}/api/devis/10/translation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        header: { description: "Edited header" },
        lines: [
          // Line 1: user changed translation → should auto-flag edited=true
          { lineNumber: 1, originalDescription: "x", translation: "User-edited en 1" },
          // Line 2: unchanged from previous → should remain edited=false
          { lineNumber: 2, originalDescription: "y", translation: "Old en 2" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(updateDevisTranslation).toHaveBeenCalledTimes(1);
    const [calledId, patch] = updateDevisTranslation.mock.calls[0];
    expect(calledId).toBe(10);
    expect(patch).toMatchObject({
      status: "edited",
      translatedPdfStorageKey: null,
      combinedPdfStorageKey: null,
      headerTranslated: { description: "Edited header" },
    });
    const lines = patch.lineTranslations as Array<{ lineNumber: number; edited: boolean; translation: string }>;
    const byNum = new Map(lines.map((l) => [l.lineNumber, l]));
    expect(byNum.get(1)?.edited).toBe(true);
    expect(byNum.get(1)?.translation).toBe("User-edited en 1");
    expect(byNum.get(2)?.edited).toBe(false);
  });

  it("returns 409 when the translation is finalised and cannot be edited", async () => {
    getDevisTranslation.mockResolvedValue({
      status: "finalised",
      headerTranslated: {},
      lineTranslations: [],
    });

    const res = await fetch(`${baseUrl}/api/devis/11/translation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ header: { description: "x" } }),
    });

    expect(res.status).toBe(409);
    expect(updateDevisTranslation).not.toHaveBeenCalled();
  });

  it("returns 404 when there is no translation row to update", async () => {
    getDevisTranslation.mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/devis/12/translation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
