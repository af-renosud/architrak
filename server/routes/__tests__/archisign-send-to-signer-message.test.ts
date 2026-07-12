import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

/**
 * Coverage for the architect-supplied message on
 * POST /api/devis/:id/send-to-signer (Task #227, hardened by Task #257).
 *
 * Pinned behaviours:
 *   (a) Zod body validation rejects messages >2000 chars with 400.
 *   (b) On the first-send branch (no envelopeId persisted) the trimmed
 *       message is forwarded to archisign.createEnvelope({ body }).
 *   (c) On the resume branch (envelopeId already persisted) /create is
 *       skipped entirely — a fresh message is silently dropped and only
 *       /send is re-invoked, regardless of what the FE sent.
 *   (d) Task #257 — the message is MANDATORY on first send: missing,
 *       whitespace-only, or <20-char messages are rejected with 422
 *       code "client_message_required" BEFORE any external call.
 *   (e) Task #257 — after a successful send, the contextual client email
 *       is dispatched (first send: the request message; resume: the
 *       persisted archisignSignerMessage) and its outcome is surfaced in
 *       the 200 response as `contextEmail`.
 */

const { storageMock, archisignMock, insuranceMock, tokenMock, emailMock } = vi.hoisted(() => ({
  storageMock: {
    getDevis: vi.fn(),
    getProject: vi.fn(),
    countOpenDevisChecks: vi.fn(),
    getLatestInsuranceOverrideForDevis: vi.fn(),
    getDevisTranslation: vi.fn(),
    updateDevis: vi.fn(),
  },
  archisignMock: {
    createEnvelope: vi.fn(),
    sendEnvelope: vi.fn(),
    assertPdfFetchUrlTtl: vi.fn(),
  },
  insuranceMock: {
    evaluateInsuranceGate: vi.fn(),
  },
  tokenMock: {
    mintPdfFetchToken: vi.fn(() => "tok_test"),
  },
  emailMock: {
    sendDevisSignatureContextEmail: vi.fn(),
  },
}));

vi.mock("../../storage", () => ({ storage: storageMock }));
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
  return {
    ArchisignError,
    createEnvelope: archisignMock.createEnvelope,
    sendEnvelope: archisignMock.sendEnvelope,
    assertPdfFetchUrlTtl: archisignMock.assertPdfFetchUrlTtl,
  };
});
vi.mock("../../services/insurance-verdict", () => ({
  evaluateInsuranceGate: insuranceMock.evaluateInsuranceGate,
}));
vi.mock("../../services/archisign-pdf-token", () => ({
  mintPdfFetchToken: tokenMock.mintPdfFetchToken,
}));
vi.mock("../../env", () => ({
  env: { PUBLIC_BASE_URL: "http://test.local" },
}));
vi.mock("../../communications/email-sender", () => ({
  sendDevisSignatureContextEmail: emailMock.sendDevisSignatureContextEmail,
}));

import archisignEnvelopesRouter from "../archisign-envelopes";

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(archisignEnvelopesRouter);
  // Mirror the global error handler shape (validateRequest → next(err))
  // so Zod parse failures surface as 400s rather than uncaught throws.
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
    signOffStage: "approved_for_signing",
    archisignEnvelopeId: null as string | null,
    archisignAccessUrl: null as string | null,
    archisignOtpDestination: null as string | null,
    archisignEnvelopeExpiresAt: null as Date | null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getDevis.mockResolvedValue(makeDevis());
  storageMock.getProject.mockResolvedValue({
    id: 9,
    clientContactName: "Marie Dupont",
    clientContactEmail: "marie@example.test",
  });
  storageMock.countOpenDevisChecks.mockResolvedValue(0);
  storageMock.getLatestInsuranceOverrideForDevis.mockResolvedValue(null);
  storageMock.getDevisTranslation.mockResolvedValue({ status: "finalised" });
  storageMock.updateDevis.mockResolvedValue(makeDevis({ signOffStage: "sent_to_client" }));
  insuranceMock.evaluateInsuranceGate.mockResolvedValue({ proceed: true, arm: "green", reason: "ok" });
  archisignMock.createEnvelope.mockResolvedValue({
    envelopeId: "env_42",
    accessUrl: "https://archisign.test/e/42",
    accessToken: "tok",
    otpDestination: "+33 6 00 00 00 00",
    expiresAt: "2026-06-30T00:00:00.000Z",
  });
  archisignMock.sendEnvelope.mockResolvedValue({ envelopeId: "env_42", status: "sent" });
  emailMock.sendDevisSignatureContextEmail.mockResolvedValue({
    communicationId: 1,
    status: "sent",
  });
});

async function postSend(devisId: number, body: unknown) {
  return fetch(`${baseUrl}/api/devis/${devisId}/send-to-signer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/devis/:id/send-to-signer — personalised message", () => {
  it("rejects messages longer than 2000 chars with a 400", async () => {
    const tooLong = "a".repeat(2001);
    const res = await postSend(100, { message: tooLong });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/2000 caractères/);
    expect(archisignMock.createEnvelope).not.toHaveBeenCalled();
    expect(archisignMock.sendEnvelope).not.toHaveBeenCalled();
  });

  it("forwards the trimmed message to createEnvelope on first-send", async () => {
    const res = await postSend(100, { message: "  Bonjour, voici le devis pour signature.  " });
    expect(res.status).toBe(200);
    expect(archisignMock.createEnvelope).toHaveBeenCalledTimes(1);
    const args = archisignMock.createEnvelope.mock.calls[0][0];
    expect(args).toMatchObject({
      externalRef: "devis-100",
      body: "Bonjour, voici le devis pour signature.",
      signer: { fullName: "Marie Dupont", email: "marie@example.test" },
    });
    expect(archisignMock.sendEnvelope).toHaveBeenCalledWith("env_42");
  });

  it("persists the trimmed message on our side in the create branch", async () => {
    const res = await postSend(100, { message: "  Bonjour, voici le devis pour signature.  " });
    expect(res.status).toBe(200);
    // The first updateDevis call is the post-/create persistence block.
    const persistCall = storageMock.updateDevis.mock.calls.find(
      (c) => (c[1] as { archisignEnvelopeId?: string }).archisignEnvelopeId === "env_42",
    );
    expect(persistCall).toBeDefined();
    expect((persistCall![1] as { archisignSignerMessage?: string | null }).archisignSignerMessage).toBe(
      "Bonjour, voici le devis pour signature.",
    );
  });

  it("rejects a first send with no message: 422 client_message_required (Task #257)", async () => {
    const res = await fetch(`${baseUrl}/api/devis/100/send-to-signer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; message: string; minLength: number };
    expect(body.code).toBe("client_message_required");
    expect(body.message).toMatch(/obligatoire/);
    expect(body.minLength).toBe(20);
    expect(archisignMock.createEnvelope).not.toHaveBeenCalled();
    expect(archisignMock.sendEnvelope).not.toHaveBeenCalled();
    expect(emailMock.sendDevisSignatureContextEmail).not.toHaveBeenCalled();
  });

  it("rejects a first send with a message shorter than 20 chars (Task #257)", async () => {
    const res = await postSend(100, { message: "Trop court." });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("client_message_required");
    expect(archisignMock.createEnvelope).not.toHaveBeenCalled();
  });

  it("forwards multi-line messages and special characters to createEnvelope verbatim", async () => {
    // Archisign HTML-escapes on its side, so we must transmit the raw plain
    // text untouched — internal newlines and < > & are preserved (only
    // leading/trailing whitespace is trimmed by the Zod schema).
    const raw = "Bonjour <Marie> & équipe,\nVoici le devis.\n\nCordialement & merci.";
    const res = await postSend(100, { message: raw });
    expect(res.status).toBe(200);
    expect(archisignMock.createEnvelope.mock.calls[0][0].body).toBe(raw);
    // And the same verbatim value is what we persist on our side.
    const persistCall = storageMock.updateDevis.mock.calls.find(
      (c) => (c[1] as { archisignEnvelopeId?: string }).archisignEnvelopeId === "env_42",
    );
    expect((persistCall![1] as { archisignSignerMessage?: string | null }).archisignSignerMessage).toBe(raw);
  });

  it("rejects whitespace-only messages on first send (collapse to absent → 422)", async () => {
    const res = await postSend(100, { message: "   \n\t   " });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("client_message_required");
    expect(archisignMock.createEnvelope).not.toHaveBeenCalled();
  });

  it("dispatches the contextual client email after a successful first send", async () => {
    const res = await postSend(100, { message: "  Bonjour, voici le devis pour signature.  " });
    expect(res.status).toBe(200);
    expect(emailMock.sendDevisSignatureContextEmail).toHaveBeenCalledTimes(1);
    expect(emailMock.sendDevisSignatureContextEmail).toHaveBeenCalledWith({
      devisId: 100,
      envelopeId: "env_42",
      message: "Bonjour, voici le devis pour signature.",
    });
    const body = (await res.json()) as { contextEmail: { status: string; communicationId: number } };
    expect(body.contextEmail).toEqual({ communicationId: 1, status: "sent" });
  });

  it("resume branch reuses the persisted archisignSignerMessage for the context email", async () => {
    storageMock.getDevis.mockResolvedValue(
      makeDevis({
        archisignEnvelopeId: "env_existing",
        archisignAccessUrl: "https://archisign.test/e/existing",
        archisignSignerMessage: "Message persisté lors de la création initiale.",
      }),
    );
    const res = await postSend(100, {});
    expect(res.status).toBe(200);
    expect(emailMock.sendDevisSignatureContextEmail).toHaveBeenCalledWith({
      devisId: 100,
      envelopeId: "env_existing",
      message: "Message persisté lors de la création initiale.",
    });
  });

  it("resume branch without any persisted message reports a failed contextEmail", async () => {
    storageMock.getDevis.mockResolvedValue(
      makeDevis({
        archisignEnvelopeId: "env_existing",
        archisignAccessUrl: "https://archisign.test/e/existing",
        archisignSignerMessage: null,
      }),
    );
    const res = await postSend(100, {});
    expect(res.status).toBe(200);
    expect(emailMock.sendDevisSignatureContextEmail).not.toHaveBeenCalled();
    const body = (await res.json()) as { contextEmail: { status: string } };
    expect(body.contextEmail.status).toBe("failed");
  });

  it("surfaces a failed contextual email in the 200 response without rolling back", async () => {
    emailMock.sendDevisSignatureContextEmail.mockResolvedValue({
      communicationId: null,
      status: "failed",
      error: "gmail down",
    });
    const res = await postSend(100, { message: "Bonjour, voici le devis pour signature." });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contextEmail: { status: string; error?: string } };
    expect(body.contextEmail.status).toBe("failed");
    expect(body.contextEmail.error).toBe("gmail down");
  });

  it("silently drops the message on the resume branch (envelopeId already persisted)", async () => {
    storageMock.getDevis.mockResolvedValue(
      makeDevis({
        archisignEnvelopeId: "env_existing",
        archisignAccessUrl: "https://archisign.test/e/existing",
        archisignOtpDestination: "+33 6 11 22 33 44",
        archisignEnvelopeExpiresAt: new Date("2026-06-30T00:00:00.000Z"),
      }),
    );

    const res = await postSend(100, {
      message: "Ce message ne devrait jamais atteindre Archisign sur la branche resume.",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resumed: boolean; archisignEnvelopeId: string };
    expect(body.resumed).toBe(true);
    expect(body.archisignEnvelopeId).toBe("env_existing");

    // createEnvelope is skipped entirely on the resume branch.
    expect(archisignMock.createEnvelope).not.toHaveBeenCalled();
    // /send still fires against the persisted envelopeId (idempotent per §S9).
    expect(archisignMock.sendEnvelope).toHaveBeenCalledWith("env_existing");
    // No updateDevis call on the resume branch may carry the message — the
    // originally persisted note must never be overwritten (incl. to null).
    for (const call of storageMock.updateDevis.mock.calls) {
      expect(call[1] as Record<string, unknown>).not.toHaveProperty("archisignSignerMessage");
    }
  });
});
