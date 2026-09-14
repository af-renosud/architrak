import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

const authState = vi.hoisted(() => ({ authenticated: true }));

vi.mock("../../auth/middleware", () => ({
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!authState.authenticated) return res.status(401).json({ message: "Authentication required" });
    (req as express.Request & { session: { userId: number } }).session = { userId: 77 };
    return next();
  },
}));

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("./helpers/mock-storage");
  return {
    storage: createStorageMock(["getProject"]),
  };
});

vi.mock("../../middleware/upload", () => ({
  intakeUpload: {
    single: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  },
}));

vi.mock("../../storage/object-storage", () => ({
  uploadDocument: vi.fn(),
  getDocumentStream: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock("../../services/intake/project-identity-resolution.service", () => ({
  confirmIntakeProjectIdentity: vi.fn(),
  getConfirmedIntakeProjectIdentity: vi.fn(),
}));

vi.mock("../../services/intake/manual-promotion.service", () => ({
  ManualPromotionError: class ManualPromotionError extends Error {},
  promoteParkedFinancialDocument: vi.fn(),
}));

vi.mock("../../services/intake/relationship-recovery.service", () => ({
  previewProjectIntakeRelationships: vi.fn(),
  applyProjectIntakeRelationships: vi.fn(),
}));

import intakeRouter from "../intake";
import { storage } from "../../storage";
import { asStorageMock } from "./helpers/mock-storage";
import {
  applyProjectIntakeRelationships,
  previewProjectIntakeRelationships,
} from "../../services/intake/relationship-recovery.service";

const storageMock = asStorageMock(storage);
const previewMock = previewProjectIntakeRelationships as unknown as ReturnType<typeof vi.fn>;
const applyMock = applyProjectIntakeRelationships as unknown as ReturnType<typeof vi.fn>;

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(intakeRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  authState.authenticated = true;
  storageMock.getProject.mockResolvedValue({ id: 8, archivedAt: null });
});

describe("project intake relationship recovery routes", () => {
  it("requires authentication for the preview", async () => {
    authState.authenticated = false;

    const response = await fetch(`${baseUrl}/api/projects/8/intake/relationships/preview`);

    expect(response.status).toBe(401);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("rejects archived projects before previewing", async () => {
    storageMock.getProject.mockResolvedValue({ id: 8, archivedAt: new Date() });

    const response = await fetch(`${baseUrl}/api/projects/8/intake/relationships/preview`);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ code: "project_archived" });
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("rejects archived projects before applying", async () => {
    storageMock.getProject.mockResolvedValue({ id: 8, archivedAt: new Date() });

    const response = await fetch(`${baseUrl}/api/projects/8/intake/relationships/re-evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "signed-preview" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ code: "project_archived" });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("returns the signed preview and accepts a verbose token", async () => {
    const token = "t".repeat(5000);
    previewMock.mockResolvedValue({
      items: [{ id: 42, fileName: "facture.pdf", canResolve: true, explanation: "Explicit chain" }],
      token,
    });
    applyMock.mockResolvedValue({ processed: 1, matched: 1, remaining: 0 });

    const previewResponse = await fetch(`${baseUrl}/api/projects/8/intake/relationships/preview`);
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({ token });

    const applyResponse = await fetch(`${baseUrl}/api/projects/8/intake/relationships/re-evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    expect(applyResponse.status).toBe(200);
    expect(await applyResponse.json()).toMatchObject({ matched: 1 });
    expect(applyMock).toHaveBeenCalledWith(8, token, "77");
  });

  it("maps generic invalid preview-token errors to a meaningful 409", async () => {
    applyMock.mockRejectedValue(
      new Error("Relationship preview token is invalid or belongs to another project."),
    );

    const response = await fetch(`${baseUrl}/api/projects/8/intake/relationships/re-evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "stale-token" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ code: "preview_token_invalid" });
    expect(body.message).toMatch(/invalid|project/i);
  });
});