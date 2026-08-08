import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

vi.mock("../../env", () => ({
  env: {
    DEFAULT_OBJECT_STORAGE_BUCKET_ID: "test-bucket",
    PRIVATE_OBJECT_DIR: "/test-bucket/.private",
    DOCRAPTOR_API_KEY: "test-docraptor-key",
    GEMINI_API_KEY: "test-gemini",
    AI_INTEGRATIONS_OPENAI_API_KEY: "test-openai",
  },
}));

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("./helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getUser",
      "getDevis",
      "getDevisTranslation",
      "updateDevisTranslation",
    ]),
  };
});

// Auth mock: inject a session only when the test sends the x-test-user header,
// so we can exercise both authenticated and unauthenticated paths.
vi.mock("../../auth/middleware", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const uid = req.header("x-test-user");
    if (!uid) return res.status(401).json({ message: "Authentication required" });
    (req as unknown as { session: { userId: number } }).session = { userId: Number(uid) };
    next();
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
  getValidatedCachedPdfKey: vi.fn(),
}));
vi.mock("../../services/devis-translation", () => ({
  translateDevis: vi.fn(),
  retranslateSingleLine: vi.fn(),
  triggerDevisTranslation: vi.fn(),
}));

import devisRouter from "../devis";
import { storage } from "../../storage";

const getDevisTranslation = storage.getDevisTranslation as unknown as ReturnType<typeof vi.fn>;
const updateDevisTranslation = storage.updateDevisTranslation as unknown as ReturnType<typeof vi.fn>;

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
});

function unlock(id: number, authed = true) {
  return fetch(`${baseUrl}/api/devis/${id}/translation/unlock`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authed ? { "x-test-user": "1" } : {}),
    },
    body: JSON.stringify({}),
  });
}

describe("POST /api/devis/:id/translation/unlock", () => {
  it("transitions a finalised translation back to edited, clearing approval fields and cached PDF keys", async () => {
    getDevisTranslation.mockResolvedValue({
      status: "finalised",
      headerTranslated: { description: "Header EN" },
      lineTranslations: [
        { lineNumber: 1, originalDescription: "x", translation: "Line EN", edited: true },
      ],
      translatedPdfStorageKey: "k/cached-translated.pdf",
      combinedPdfStorageKey: "k/cached-combined.pdf",
      approvedAt: new Date("2026-01-01"),
      approvedBy: 7,
      approvedByEmail: "arch@example.com",
    });
    updateDevisTranslation.mockImplementation(async (_id: number, patch: Record<string, unknown>) => patch);

    const res = await unlock(20);
    expect(res.status).toBe(200);
    expect(updateDevisTranslation).toHaveBeenCalledTimes(1);
    const [calledId, patch] = updateDevisTranslation.mock.calls[0];
    expect(calledId).toBe(20);
    expect(patch).toMatchObject({
      status: "edited",
      translatedPdfStorageKey: null,
      combinedPdfStorageKey: null,
      approvedAt: null,
      approvedBy: null,
      approvedByEmail: null,
    });
    // Crucially, no translated-content fields are touched: text is preserved.
    expect(patch).not.toHaveProperty("headerTranslated");
    expect(patch).not.toHaveProperty("lineTranslations");
  });

  it("rejects unlocking a non-finalised translation with 409", async () => {
    getDevisTranslation.mockResolvedValue({ status: "edited" });
    const res = await unlock(21);
    expect(res.status).toBe(409);
    expect(updateDevisTranslation).not.toHaveBeenCalled();
  });

  it("returns 404 when there is no translation row", async () => {
    getDevisTranslation.mockResolvedValue(null);
    const res = await unlock(22);
    expect(res.status).toBe(404);
    expect(updateDevisTranslation).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const res = await unlock(23, false);
    expect(res.status).toBe(401);
    expect(getDevisTranslation).not.toHaveBeenCalled();
    expect(updateDevisTranslation).not.toHaveBeenCalled();
  });
});
