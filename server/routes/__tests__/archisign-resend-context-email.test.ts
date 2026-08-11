import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

/**
 * Coverage for Task #258 — architect-facing recovery of a failed
 * devis-signature context email:
 *
 *   GET  /api/devis/:id/context-email-status
 *   POST /api/devis/:id/resend-context-email
 *
 * Pinned behaviours:
 *   (a) Status: canResend=false with reason when the devis has no
 *       envelopeId or no persisted archisignSignerMessage.
 *   (b) Status: canResend=false when the communication row for the
 *       CURRENT envelope's dedupeKey is `sent`; true when the row is
 *       missing or in any non-sent status (queued/failed).
 *   (c) Resend: 409 (no_envelope / no_message) when preconditions are
 *       missing — sendDevisSignatureContextEmail is never invoked.
 *   (d) Resend: dispatches with the PERSISTED archisignSignerMessage and
 *       the current envelopeId; 200 on `sent` and `already_sent`.
 *   (e) Resend: 502 code context_email_failed when the dispatch reports
 *       `failed`.
 */

const { emailMock } = vi.hoisted(() => ({
  emailMock: {
    sendDevisSignatureContextEmail: vi.fn(),
  },
}));

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("./helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getDevis",
      "getProject",
      "countOpenDevisChecks",
      "getLatestInsuranceOverrideForDevis",
      "getDevisTranslation",
      "updateDevis",
      "getProjectCommunicationByDedupeKey",
    ]),
  };
});
vi.mock("../../auth/middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  },
}));
vi.mock("../../services/archisign", () => {
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
  return {
    ArchisignError,
    ArchisignConfigError,
    createEnvelope: vi.fn(),
    sendEnvelope: vi.fn(),
    assertPdfFetchUrlTtl: vi.fn(),
  };
});
vi.mock("../../services/insurance-verdict", () => ({
  evaluateInsuranceGate: vi.fn(),
}));
vi.mock("../../services/archisign-pdf-token", () => ({
  mintPdfFetchToken: vi.fn(() => "tok_test"),
}));
vi.mock("../../env", () => ({
  env: { PUBLIC_BASE_URL: "http://test.local" },
}));
vi.mock("../../communications/email-sender", () => ({
  sendDevisSignatureContextEmail: emailMock.sendDevisSignatureContextEmail,
}));

import archisignEnvelopesRouter from "../archisign-envelopes";
import { storage } from "../../storage";
import { asStorageMock } from "./helpers/mock-storage";

const storageMock = asStorageMock(storage);

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(archisignEnvelopesRouter);
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

function makeDevis(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    devisCode: "LOT01-001",
    projectId: 9,
    signOffStage: "sent_to_client",
    archisignEnvelopeId: "env_42" as string | null,
    archisignSignerMessage: "Bonjour Marie, voici le contexte du devis." as string | null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getDevis.mockResolvedValue(makeDevis());
  storageMock.getProjectCommunicationByDedupeKey.mockResolvedValue(undefined);
  emailMock.sendDevisSignatureContextEmail.mockResolvedValue({
    communicationId: 1,
    status: "sent",
  });
});

async function getStatus(devisId: number) {
  return fetch(`${baseUrl}/api/devis/${devisId}/context-email-status`);
}

async function postResend(devisId: number) {
  return fetch(`${baseUrl}/api/devis/${devisId}/resend-context-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

describe("GET /api/devis/:id/context-email-status", () => {
  it("404s when the devis does not exist", async () => {
    storageMock.getDevis.mockResolvedValue(undefined);
    const res = await getStatus(100);
    expect(res.status).toBe(404);
  });

  it("canResend=false reason=no_envelope when no envelopeId is persisted", async () => {
    storageMock.getDevis.mockResolvedValue(makeDevis({ archisignEnvelopeId: null }));
    const res = await getStatus(100);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ canResend: false, emailStatus: null, reason: "no_envelope" });
    expect(storageMock.getProjectCommunicationByDedupeKey).not.toHaveBeenCalled();
  });

  it("canResend=false reason=no_message when no signer message is persisted", async () => {
    storageMock.getDevis.mockResolvedValue(makeDevis({ archisignSignerMessage: "   " }));
    const res = await getStatus(100);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ canResend: false, emailStatus: null, reason: "no_message" });
  });

  it("looks up the exact dedupeKey for the current envelope", async () => {
    await getStatus(100);
    expect(storageMock.getProjectCommunicationByDedupeKey).toHaveBeenCalledWith(
      "devis-signature-context:100:env_42",
    );
  });

  it("canResend=false when the communication row is already sent", async () => {
    storageMock.getProjectCommunicationByDedupeKey.mockResolvedValue({
      id: 7,
      status: "sent",
    });
    const res = await getStatus(100);
    const body = await res.json();
    expect(body).toEqual({ canResend: false, emailStatus: "sent", reason: null });
  });

  it("canResend=true when no communication row exists at all", async () => {
    const res = await getStatus(100);
    const body = await res.json();
    expect(body).toEqual({ canResend: true, emailStatus: null, reason: null });
  });

  it("canResend=true when the communication row is in a non-sent status", async () => {
    storageMock.getProjectCommunicationByDedupeKey.mockResolvedValue({
      id: 7,
      status: "failed",
    });
    const res = await getStatus(100);
    const body = await res.json();
    expect(body).toEqual({ canResend: true, emailStatus: "failed", reason: null });
  });
});

describe("POST /api/devis/:id/resend-context-email", () => {
  it("404s when the devis does not exist", async () => {
    storageMock.getDevis.mockResolvedValue(undefined);
    const res = await postResend(100);
    expect(res.status).toBe(404);
    expect(emailMock.sendDevisSignatureContextEmail).not.toHaveBeenCalled();
  });

  it("409 no_envelope when no envelopeId is persisted", async () => {
    storageMock.getDevis.mockResolvedValue(makeDevis({ archisignEnvelopeId: null }));
    const res = await postResend(100);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("no_envelope");
    expect(emailMock.sendDevisSignatureContextEmail).not.toHaveBeenCalled();
  });

  it("409 no_message when no signer message is persisted", async () => {
    storageMock.getDevis.mockResolvedValue(makeDevis({ archisignSignerMessage: null }));
    const res = await postResend(100);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("no_message");
    expect(emailMock.sendDevisSignatureContextEmail).not.toHaveBeenCalled();
  });

  it("dispatches with the persisted message and current envelopeId, 200 on sent", async () => {
    const res = await postResend(100);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      contextEmail: { communicationId: 1, status: "sent" },
    });
    expect(emailMock.sendDevisSignatureContextEmail).toHaveBeenCalledTimes(1);
    expect(emailMock.sendDevisSignatureContextEmail).toHaveBeenCalledWith({
      devisId: 100,
      envelopeId: "env_42",
      message: "Bonjour Marie, voici le contexte du devis.",
    });
  });

  it("200 already_sent passes through the dedupe short-circuit", async () => {
    emailMock.sendDevisSignatureContextEmail.mockResolvedValue({
      communicationId: 5,
      status: "already_sent",
    });
    const res = await postResend(100);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contextEmail.status).toBe("already_sent");
  });

  it("502 context_email_failed when the dispatch fails again", async () => {
    emailMock.sendDevisSignatureContextEmail.mockResolvedValue({
      communicationId: null,
      status: "failed",
      error: "Gmail connector unavailable",
    });
    const res = await postResend(100);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("context_email_failed");
    expect(body.message).toContain("Gmail connector unavailable");
    expect(body.contextEmail.status).toBe("failed");
  });
});
