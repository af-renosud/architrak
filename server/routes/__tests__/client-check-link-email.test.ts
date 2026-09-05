import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

const { serviceMock, emailMock } = vi.hoisted(() => ({
  serviceMock: {
    issueClientCheckTokenEmail: vi.fn(),
  },
  emailMock: {
    sendCommunication: vi.fn(),
  },
}));

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("./helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getDevis",
      "getProject",
      "getUser",
      "listClientChecks",
      "createClientCheckMessage",
      "getLatestClientCheckToken",
      "getActiveClientCheckToken",
      "getProjectCommunication",
      "getProjectCommunicationByDedupeKey",
    ]),
  };
});

vi.mock("../../services/client-checks", () => ({
  issueClientCheckTokenEmail: serviceMock.issueClientCheckTokenEmail,
  clientLinkDeliveryDedupeKey: (tokenId: number) => `devis-client-link:${tokenId}`,
  computeTokenExpiry: () => new Date("2026-12-01T00:00:00.000Z"),
  isTokenExpired: (token: { expiresAt: Date | null }) =>
    !!token.expiresAt && token.expiresAt.getTime() <= Date.now(),
}));

vi.mock("../../communications/email-sender", () => {
  class CommunicationSendInProgressError extends Error {}
  return {
    isValidRecipientEmail: (email: string) =>
      /^[^\s@,;<>"()[\]\\]+@[^\s@,;<>"()[\]\\]+\.[A-Za-z0-9-]{2,}$/.test(email),
    sendCommunication: emailMock.sendCommunication,
    CommunicationSendInProgressError,
  };
});

vi.mock("../../env", () => ({
  env: {
    PUBLIC_BASE_URL: "https://architrak.test",
    DEVIS_CHECK_TOKEN_TTL_DAYS: 90,
  },
}));

vi.mock("../public-client-checks", () => ({
  buildClientPortalPayload: vi.fn(),
  renderClientPortalShell: vi.fn(() => "<html></html>"),
  streamCombinedPackagePdf: vi.fn(),
}));

vi.mock("../../storage/object-storage", () => ({
  getDocumentStream: vi.fn(),
}));

import clientChecksRouter from "../client-checks";
import { storage } from "../../storage";
import { asStorageMock } from "./helpers/mock-storage";

const storageMock = asStorageMock(storage);
let server: import("http").Server;
let baseUrl: string;

const token = {
  id: 71,
  devisId: 100,
  tokenHash: "not-returned",
  clientEmail: "marie@example.test",
  clientName: "Marie Dupont",
  createdByUserId: 1,
  createdAt: new Date("2026-09-05T09:00:00.000Z"),
  lastUsedAt: null,
  expiresAt: new Date("2026-12-04T09:00:00.000Z"),
  revokedAt: null,
};

const queuedCommunication = {
  id: 501,
  projectId: 9,
  type: "devis_client_link",
  recipientType: "client",
  recipientEmail: "marie@example.test",
  recipientName: "Marie Dupont",
  subject: "Devis D-100 — Maison Dupont",
  body: "private email body",
  attachmentStorageKeys: null,
  status: "queued",
  sentAt: null,
  emailMessageId: null,
  emailThreadId: null,
  dedupeKey: "devis-client-link:71",
  sentViaUserId: null,
  relatedCertificatId: null,
  relatedInvoiceId: null,
  archivedAt: null,
  createdAt: new Date("2026-09-05T09:00:00.000Z"),
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  });
  app.use(clientChecksRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getDevis.mockResolvedValue({
    id: 100,
    projectId: 9,
    devisCode: "D-100",
    devisNumber: null,
    status: "pending",
    accountingState: "current",
  });
  storageMock.getProject.mockResolvedValue({
    id: 9,
    name: "Maison Dupont",
    archivedAt: null,
  });
  storageMock.getUser.mockResolvedValue({
    id: 1,
    email: "architect@example.test",
    firstName: "Alice",
    lastName: "Martin",
  });
  storageMock.listClientChecks.mockResolvedValue([]);
  storageMock.getLatestClientCheckToken.mockResolvedValue(token);
  storageMock.getActiveClientCheckToken.mockResolvedValue(token);
  storageMock.getProjectCommunicationByDedupeKey.mockResolvedValue(queuedCommunication);
  storageMock.getProjectCommunication.mockResolvedValue({
    ...queuedCommunication,
    status: "sent",
    sentAt: new Date("2026-09-05T09:01:00.000Z"),
  });
  serviceMock.issueClientCheckTokenEmail.mockResolvedValue({
    record: token,
    communication: queuedCommunication,
    reused: false,
  });
  emailMock.sendCommunication.mockResolvedValue(undefined);
});

async function post(path: string, body: unknown = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("per-devis client link email", () => {
  it("validates the custom message and strict single recipient before issuing a link", async () => {
    const short = await post("/api/devis/100/client-check-token/issue", {
      clientEmail: "marie@example.test",
      message: "short",
    });
    expect(short.status).toBe(400);

    const injected = await post("/api/devis/100/client-check-token/issue", {
      clientEmail: "marie@example.test\r\nBcc: attacker@example.test",
      message: "Please review this quotation.",
    });
    expect(injected.status).toBe(400);
    expect(serviceMock.issueClientCheckTokenEmail).not.toHaveBeenCalled();
  });

  it("queues, sends and returns only safe token and delivery provenance", async () => {
    const res = await post("/api/devis/100/client-check-token/issue", {
      clientEmail: "marie@example.test",
      clientName: " Marie Dupont ",
      message: "  Please review the attached quotation details.  ",
    });
    expect(res.status).toBe(200);
    expect(serviceMock.issueClientCheckTokenEmail).toHaveBeenCalledWith(expect.objectContaining({
      clientName: "Marie Dupont",
      message: "Please review the attached quotation details.",
      createdByUserId: 1,
    }));
    expect(emailMock.sendCommunication).toHaveBeenCalledWith(501, { sentByUserId: 1 });
    const body = await res.json();
    expect(body.token.tokenHash).toBeUndefined();
    expect(body.delivery).toMatchObject({
      communicationId: 501,
      status: "sent",
      sentAt: "2026-09-05T09:01:00.000Z",
    });
    expect(body.delivery.body).toBeUndefined();
  });

  it("leaves failed delivery visible without a false sent timestamp", async () => {
    emailMock.sendCommunication.mockRejectedValueOnce(new Error("Gmail unavailable"));
    storageMock.getProjectCommunication.mockResolvedValueOnce({
      ...queuedCommunication,
      status: "failed",
      sentAt: null,
    });
    const res = await post("/api/devis/100/client-check-token/issue", {
      clientEmail: "marie@example.test",
      message: "Please review this quotation.",
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.delivery).toMatchObject({ communicationId: 501, status: "failed", sentAt: null });
  });

  it("retries the existing communication without rotating another token", async () => {
    storageMock.getProjectCommunicationByDedupeKey.mockResolvedValue({
      ...queuedCommunication,
      status: "failed",
    });
    const res = await post("/api/devis/100/client-check-token/resend");
    expect(res.status).toBe(200);
    expect(serviceMock.issueClientCheckTokenEmail).not.toHaveBeenCalled();
    expect(emailMock.sendCommunication).toHaveBeenCalledWith(501, { sentByUserId: 1 });
  });

  it("refuses duplicate in-flight issue requests and archived projects", async () => {
    serviceMock.issueClientCheckTokenEmail.mockResolvedValueOnce({
      record: token,
      communication: { ...queuedCommunication, status: "sending" },
      reused: true,
    });
    const duplicate = await post("/api/devis/100/client-check-token/issue", {
      clientEmail: "marie@example.test",
      message: "Please review this quotation.",
    });
    expect(duplicate.status).toBe(409);
    expect(emailMock.sendCommunication).not.toHaveBeenCalled();

    storageMock.getProject.mockResolvedValueOnce({
      id: 9,
      name: "Maison Dupont",
      archivedAt: new Date(),
    });
    const archived = await post("/api/devis/100/client-check-token/issue", {
      clientEmail: "marie@example.test",
      message: "Please review this quotation.",
    });
    expect(archived.status).toBe(409);
    expect(serviceMock.issueClientCheckTokenEmail).toHaveBeenCalledTimes(1);
  });

  it("reads the exact delivery record and exposes its successful sent date", async () => {
    storageMock.getProjectCommunicationByDedupeKey.mockResolvedValue({
      ...queuedCommunication,
      body: "Please review:\nhttps://architrak.test/p/client/secret-token_123\nRegards",
      status: "sent",
      sentAt: new Date("2026-09-05T09:01:00.000Z"),
    });
    const res = await fetch(`${baseUrl}/api/devis/100/client-check-token`);
    expect(res.status).toBe(200);
    expect(storageMock.getProjectCommunicationByDedupeKey).toHaveBeenCalledWith("devis-client-link:71");
    const body = await res.json();
    expect(body.delivery).toMatchObject({
      status: "sent",
      sentAt: "2026-09-05T09:01:00.000Z",
      recipientEmail: "marie@example.test",
      portalUrl: "https://architrak.test/p/client/secret-token_123",
    });
  });
});