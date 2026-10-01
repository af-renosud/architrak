import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => ({
  authenticated: true,
  storage: {
    getEmailDocuments: vi.fn(),
    getEmailDocument: vi.fn(),
    getAppSetting: vi.fn(),
    updateEmailDocument: vi.fn(),
  },
  enrich: vi.fn(),
  processEmailDocument: vi.fn(),
  pollInbox: vi.fn(),
}));

vi.mock("../../storage", () => ({ storage: mocks.storage }));
vi.mock("../../gmail/monitor", () => ({
  getGmailMonitorStatus: vi.fn(),
  pollInbox: mocks.pollInbox,
}));
vi.mock("../../gmail/document-parser", () => ({ processEmailDocument: mocks.processEmailDocument }));
vi.mock("../../services/email-document-filing.service", () => ({ enrichEmailDocumentsWithFiling: mocks.enrich }));
vi.mock("../../services/email-document-dismiss.service", () => ({
  dismissEmailDocument: vi.fn(),
  purgeSkippedEmailDocument: vi.fn(),
  DismissRefusedError: class DismissRefusedError extends Error {},
}));
vi.mock("../../services/email-document-processor.service", () => ({
  EMAIL_PURGE_DAYS_KEY: "email_purge_days",
  EMAIL_PURGE_DAYS_DEFAULT: 30,
}));
vi.mock("../../services/intake/manual-promotion.service", () => ({
  ManualPromotionError: class ManualPromotionError extends Error {},
  promoteParkedFinancialDocument: vi.fn(),
}));

import gmailRouter from "../gmail";

let baseUrl: string;
let server: import("http").Server;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Exercise the real requireAuth middleware without auth providers/session DB.
  app.use((req, _res, next) => {
    if (mocks.authenticated) req.session = { userId: 77 } as typeof req.session;
    next();
  });
  app.use(gmailRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ZodError ? 400 : 500)
      .json({ message: error instanceof Error ? error.message : String(error) });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticated = true;
});

const doc = { id: 898, projectId: 12, extractionStatus: "completed", devisId: null };
const enriched = {
  ...doc,
  filing: {
    state: "filed", label: "Added to project", reason: null, intakeId: 80, projectId: 12,
    promotedKind: "devis", promotedId: 35, isActive: false,
    destination: { href: "/projets/12?devis=35", label: "Open devis" },
  },
};

describe("read-only email document filing GET routes", () => {
  it.each(["/api/email-documents", "/api/email-documents/898"])("requires explicit authentication on %s", async (path) => {
    mocks.authenticated = false;
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(401);
    expect(mocks.storage.getEmailDocuments).not.toHaveBeenCalled();
    expect(mocks.storage.getEmailDocument).not.toHaveBeenCalled();
    expect(mocks.enrich).not.toHaveBeenCalled();
  });

  it("preserves list filter conventions and enriches the entire result in one call", async () => {
    mocks.storage.getEmailDocuments.mockResolvedValue([doc]);
    mocks.enrich.mockResolvedValue([enriched]);
    const response = await fetch(`${baseUrl}/api/email-documents?projectId=12&status=completed&documentType=devis`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([enriched]);
    expect(mocks.storage.getEmailDocuments).toHaveBeenCalledWith({
      projectId: 12, status: "completed", documentType: "devis",
    });
    expect(mocks.enrich).toHaveBeenCalledExactlyOnceWith([doc]);
    expect(mocks.storage.updateEmailDocument).not.toHaveBeenCalled();
    expect(mocks.processEmailDocument).not.toHaveBeenCalled();
    expect(mocks.pollInbox).not.toHaveBeenCalled();
  });

  it("returns the same enriched contract on detail without mutation", async () => {
    mocks.storage.getEmailDocument.mockResolvedValue(doc);
    mocks.enrich.mockResolvedValue([enriched]);
    const response = await fetch(`${baseUrl}/api/email-documents/898`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(enriched);
    expect(mocks.storage.getEmailDocument).toHaveBeenCalledWith(898);
    expect(mocks.enrich).toHaveBeenCalledExactlyOnceWith([doc]);
    expect(mocks.storage.updateEmailDocument).not.toHaveBeenCalled();
    expect(mocks.processEmailDocument).not.toHaveBeenCalled();
  });

  it("keeps missing document detail as 404 without lookup enrichment", async () => {
    mocks.storage.getEmailDocument.mockResolvedValue(undefined);
    const response = await fetch(`${baseUrl}/api/email-documents/99999`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Document not found" });
    expect(mocks.enrich).not.toHaveBeenCalled();
  });

  it("invalid ids and project filters stop before storage/enrichment", async () => {
    const detail = await fetch(`${baseUrl}/api/email-documents/not-an-id`);
    const list = await fetch(`${baseUrl}/api/email-documents?projectId=-1`);
    expect(detail.status).toBe(400);
    expect(list.status).toBe(400);
    expect(mocks.storage.getEmailDocuments).not.toHaveBeenCalled();
    expect(mocks.storage.getEmailDocument).not.toHaveBeenCalled();
    expect(mocks.enrich).not.toHaveBeenCalled();
  });

  it("surfaces an enrichment database failure rather than returning a misleading bare document", async () => {
    mocks.storage.getEmailDocuments.mockResolvedValue([doc]);
    mocks.enrich.mockRejectedValue(new Error("Filing lookup unavailable"));
    const response = await fetch(`${baseUrl}/api/email-documents`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "Filing lookup unavailable" });
  });

  it("does not add global router authentication or capture the existing settings GET as an id", async () => {
    mocks.authenticated = false;
    mocks.storage.getAppSetting.mockResolvedValue("45");
    const response = await fetch(`${baseUrl}/api/email-documents/settings/purge`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purgeDays: 45 });
    expect(mocks.enrich).not.toHaveBeenCalled();
  });
});