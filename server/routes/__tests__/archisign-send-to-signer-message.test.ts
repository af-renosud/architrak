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

const { archisignMock, insuranceMock, tokenMock, emailMock } = vi.hoisted(() => ({
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
    createEnvelope: archisignMock.createEnvelope,
    sendEnvelope: archisignMock.sendEnvelope,
    assertPdfFetchUrlTtl: archisignMock.assertPdfFetchUrlTtl,
    // Task #269 — real (English) subject builder, not a stub, so the
    // subject forwarded to createEnvelope stays asserted here.
    buildArchisignEnvelopeSubject: (devisCode: string) =>
      `Electronic signature request — devis ${devisCode}`,
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
// Task #378 — the send route now pins the exact PDF bytes before minting the
// fetch token; return a stable cached key so no real PDF generation runs.
vi.mock("../../communications/devis-translation-generator", () => ({
  getValidatedCachedPdfKey: vi.fn(async () => "cache/pinned-test.pdf"),
  generateCombinedPdf: vi.fn(async () => {
    throw new Error("not expected in this test");
  }),
  generateDevisTranslationPdf: vi.fn(async () => {
    throw new Error("not expected in this test");
  }),
}));

import archisignEnvelopesRouter from "../archisign-envelopes";
import { storage } from "../../storage";
import { DEVIS_CLIENT_MESSAGE_MAX_LEN } from "@shared/schema";
import { CLIENT_NO_PAYMENT_NOTICE } from "@shared/signature-message-template";
import { asStorageMock } from "./helpers/mock-storage";

const storageMock = asStorageMock(storage);

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
  it("rejects messages longer than the max (Archisign 2000-cap minus the fixed notice) with a 400", async () => {
    // Task #442 — the server appends "\n\n" + CLIENT_NO_PAYMENT_NOTICE to
    // the envelope body, so the architect's allowance shrinks in lockstep
    // to keep the combined body within Archisign's 2000-code-point cap.
    expect(DEVIS_CLIENT_MESSAGE_MAX_LEN + CLIENT_NO_PAYMENT_NOTICE.length + 2).toBe(2000);
    const tooLong = "a".repeat(DEVIS_CLIENT_MESSAGE_MAX_LEN + 1);
    const res = await postSend(100, { message: tooLong });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(new RegExp(`${DEVIS_CLIENT_MESSAGE_MAX_LEN} characters`));
    expect(archisignMock.createEnvelope).not.toHaveBeenCalled();
    expect(archisignMock.sendEnvelope).not.toHaveBeenCalled();

    // A maximal-length message still succeeds, and the combined envelope
    // body (message + "\n\n" + notice) lands exactly on the 2000 cap.
    const maximal = "a".repeat(DEVIS_CLIENT_MESSAGE_MAX_LEN);
    const okRes = await postSend(100, { message: maximal });
    expect(okRes.status).toBe(200);
    const sentBody = archisignMock.createEnvelope.mock.calls[0][0].body as string;
    expect(sentBody.length).toBe(2000);
  });

  it("forwards the trimmed message to createEnvelope on first-send", async () => {
    const res = await postSend(100, { message: "  Bonjour, voici le devis pour signature.  " });
    expect(res.status).toBe(200);
    expect(archisignMock.createEnvelope).toHaveBeenCalledTimes(1);
    const args = archisignMock.createEnvelope.mock.calls[0][0];
    expect(args).toMatchObject({
      externalRef: "devis-100",
      // Task #442 — the fixed payment warning is appended server-side,
      // outside the architect's editable text.
      body:
        "Bonjour, voici le devis pour signature.\n\n" +
        "Don't pay anything now. At this stage, you are only authorising the quotation. " +
        "Payment instructions will follow.",
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
    expect(body.message).toMatch(/required/);
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
    // Task #442 — the architect's text is forwarded untouched, with only the
    // fixed payment warning appended after it (server-guaranteed block).
    expect(archisignMock.createEnvelope.mock.calls[0][0].body).toBe(
      raw +
        "\n\nDon't pay anything now. At this stage, you are only authorising the quotation. " +
        "Payment instructions will follow.",
    );
    // The RAW verbatim value (without the notice) is what we persist on our side.
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

describe("POST /api/devis/:id/send-to-signer — Mode B finalised-translation gate (Task #374)", () => {
  it.each(["draft", "edited"])("409 translation_not_finalised for a mode_b devis with a %s translation", async (status) => {
    storageMock.getDevis.mockResolvedValue(makeDevis({ invoicingMode: "mode_b" }));
    storageMock.getDevisTranslation.mockResolvedValue({ status });
    const res = await postSend(100, { message: "Bonjour, voici le devis pour signature — merci." });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("translation_not_finalised");
    expect(body.translationStatus).toBe(status);
    expect(archisignMock.createEnvelope).not.toHaveBeenCalled();
  });

  it("allows a mode_b send with a finalised translation", async () => {
    storageMock.getDevis.mockResolvedValue(makeDevis({ invoicingMode: "mode_b" }));
    storageMock.getDevisTranslation.mockResolvedValue({ status: "finalised" });
    const res = await postSend(100, { message: "Bonjour, voici le devis pour signature — merci." });
    expect(res.status).toBe(200);
    expect(archisignMock.createEnvelope).toHaveBeenCalled();
  });

  it("still accepts draft/edited translations for mode_a devis", async () => {
    storageMock.getDevis.mockResolvedValue(makeDevis({ invoicingMode: "mode_a" }));
    storageMock.getDevisTranslation.mockResolvedValue({ status: "draft" });
    const res = await postSend(100, { message: "Bonjour, voici le devis pour signature — merci." });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/devis/:id/send-to-signer — §3.5.1.1(c) subject-rendering drift (Task #279)", () => {
  const VALID_MESSAGE = "Bonjour, voici le devis pour signature.";

  function findPersistCall() {
    return storageMock.updateDevis.mock.calls.find(
      (c) => (c[1] as { archisignEnvelopeId?: string }).archisignEnvelopeId === "env_42",
    );
  }

  it("persists archisignSubjectDriftAt and returns subjectDrift=true when the echo reports subjectApplied=false", async () => {
    archisignMock.createEnvelope.mockResolvedValue({
      envelopeId: "env_42",
      accessUrl: "https://archisign.test/e/42",
      accessToken: "tok",
      otpDestination: "+33 6 00 00 00 00",
      expiresAt: "2026-06-30T00:00:00.000Z",
      emailRendering: { subjectApplied: false, bodyApplied: false },
    });
    const res = await postSend(100, { message: VALID_MESSAGE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subjectDrift: boolean };
    // Non-blocking: envelope proceeded (200) AND /send fired…
    expect(archisignMock.sendEnvelope).toHaveBeenCalledWith("env_42");
    // …but the drift is flagged in the response and persisted.
    expect(body.subjectDrift).toBe(true);
    const persistCall = findPersistCall();
    expect(persistCall).toBeDefined();
    expect(
      (persistCall![1] as { archisignSubjectDriftAt?: Date | null }).archisignSubjectDriftAt,
    ).toBeInstanceOf(Date);
  });

  it("persists NULL and returns subjectDrift=false when the echo confirms subjectApplied=true", async () => {
    archisignMock.createEnvelope.mockResolvedValue({
      envelopeId: "env_42",
      accessUrl: "https://archisign.test/e/42",
      accessToken: "tok",
      otpDestination: "+33 6 00 00 00 00",
      expiresAt: "2026-06-30T00:00:00.000Z",
      emailRendering: { subjectApplied: true, bodyApplied: false },
    });
    const res = await postSend(100, { message: VALID_MESSAGE });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { subjectDrift: boolean }).subjectDrift).toBe(false);
    const persistCall = findPersistCall();
    expect(
      (persistCall![1] as { archisignSubjectDriftAt?: Date | null }).archisignSubjectDriftAt,
    ).toBeNull();
  });

  it("persists NULL when the echo is absent (pre-v1.2 Archisign) — clears stale drift from a previous envelope", async () => {
    // Default createEnvelope mock has no emailRendering field.
    const res = await postSend(100, { message: VALID_MESSAGE });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { subjectDrift: boolean }).subjectDrift).toBe(false);
    const persistCall = findPersistCall();
    expect(persistCall).toBeDefined();
    // Explicit null (not undefined/absent): a fresh envelope without drift
    // must CLEAR any flag left over from a previous, expired envelope.
    expect(
      (persistCall![1] as Record<string, unknown>).archisignSubjectDriftAt,
    ).toBeNull();
  });

  it("resume branch reports the persisted drift flag without touching it", async () => {
    storageMock.getDevis.mockResolvedValue(
      makeDevis({
        archisignEnvelopeId: "env_existing",
        archisignAccessUrl: "https://archisign.test/e/existing",
        archisignSignerMessage: "Message persisté lors de la création initiale.",
        archisignSubjectDriftAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    );
    const res = await postSend(100, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resumed: boolean; subjectDrift: boolean };
    expect(body.resumed).toBe(true);
    expect(body.subjectDrift).toBe(true);
    expect(archisignMock.createEnvelope).not.toHaveBeenCalled();
    // The resume branch never rewrites the drift flag.
    for (const call of storageMock.updateDevis.mock.calls) {
      expect(call[1] as Record<string, unknown>).not.toHaveProperty("archisignSubjectDriftAt");
    }
  });
});

describe("POST /api/devis/:id/send-to-signer — §3.5.1.1(b) body-rendering drift (Task #283)", () => {
  const VALID_MESSAGE = "Bonjour, voici le devis pour signature.";

  function findPersistCall() {
    return storageMock.updateDevis.mock.calls.find(
      (c) => (c[1] as { archisignEnvelopeId?: string }).archisignEnvelopeId === "env_42",
    );
  }

  function mockCreateWithEcho(echo: { subjectApplied: boolean; bodyApplied: boolean }) {
    archisignMock.createEnvelope.mockResolvedValue({
      envelopeId: "env_42",
      accessUrl: "https://archisign.test/e/42",
      accessToken: "tok",
      otpDestination: "+33 6 00 00 00 00",
      expiresAt: "2026-06-30T00:00:00.000Z",
      emailRendering: echo,
    });
  }

  it("persists archisignBodyDriftAt and returns bodyDrift=true when the echo reports bodyApplied=false for a sent message", async () => {
    mockCreateWithEcho({ subjectApplied: true, bodyApplied: false });
    const res = await postSend(100, { message: VALID_MESSAGE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subjectDrift: boolean; bodyDrift: boolean };
    // Non-blocking: envelope proceeded (200) AND /send fired…
    expect(archisignMock.sendEnvelope).toHaveBeenCalledWith("env_42");
    // …but the body drift is flagged and persisted; subject is clean.
    expect(body.bodyDrift).toBe(true);
    expect(body.subjectDrift).toBe(false);
    const persistCall = findPersistCall();
    expect(persistCall).toBeDefined();
    expect(
      (persistCall![1] as { archisignBodyDriftAt?: Date | null }).archisignBodyDriftAt,
    ).toBeInstanceOf(Date);
    expect(
      (persistCall![1] as { archisignSubjectDriftAt?: Date | null }).archisignSubjectDriftAt,
    ).toBeNull();
  });

  it("persists NULL and returns bodyDrift=false when the echo confirms bodyApplied=true", async () => {
    mockCreateWithEcho({ subjectApplied: true, bodyApplied: true });
    const res = await postSend(100, { message: VALID_MESSAGE });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { bodyDrift: boolean }).bodyDrift).toBe(false);
    const persistCall = findPersistCall();
    expect(
      (persistCall![1] as { archisignBodyDriftAt?: Date | null }).archisignBodyDriftAt,
    ).toBeNull();
  });

  it("persists NULL when the echo is absent (pre-v1.2 Archisign) — clears stale body drift", async () => {
    // Default createEnvelope mock has no emailRendering field.
    const res = await postSend(100, { message: VALID_MESSAGE });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { bodyDrift: boolean }).bodyDrift).toBe(false);
    const persistCall = findPersistCall();
    expect(persistCall).toBeDefined();
    // Explicit null (not undefined/absent): a fresh envelope without drift
    // must CLEAR any flag left over from a previous, expired envelope.
    expect(
      (persistCall![1] as Record<string, unknown>).archisignBodyDriftAt,
    ).toBeNull();
  });

  it("flags BOTH drifts independently when subject and body are dropped together", async () => {
    mockCreateWithEcho({ subjectApplied: false, bodyApplied: false });
    const res = await postSend(100, { message: VALID_MESSAGE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subjectDrift: boolean; bodyDrift: boolean };
    expect(body.subjectDrift).toBe(true);
    expect(body.bodyDrift).toBe(true);
    const persistCall = findPersistCall();
    expect(
      (persistCall![1] as { archisignSubjectDriftAt?: Date | null }).archisignSubjectDriftAt,
    ).toBeInstanceOf(Date);
    expect(
      (persistCall![1] as { archisignBodyDriftAt?: Date | null }).archisignBodyDriftAt,
    ).toBeInstanceOf(Date);
  });

  it("resume branch reports the persisted body-drift flag without touching it", async () => {
    storageMock.getDevis.mockResolvedValue(
      makeDevis({
        archisignEnvelopeId: "env_existing",
        archisignAccessUrl: "https://archisign.test/e/existing",
        archisignSignerMessage: "Message persisté lors de la création initiale.",
        archisignBodyDriftAt: new Date("2026-07-10T00:00:00.000Z"),
      }),
    );
    const res = await postSend(100, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resumed: boolean; bodyDrift: boolean };
    expect(body.resumed).toBe(true);
    expect(body.bodyDrift).toBe(true);
    expect(archisignMock.createEnvelope).not.toHaveBeenCalled();
    // The resume branch never rewrites the drift flag.
    for (const call of storageMock.updateDevis.mock.calls) {
      expect(call[1] as Record<string, unknown>).not.toHaveProperty("archisignBodyDriftAt");
    }
  });
});

/**
 * Task #434 — an Archisign OUTAGE must not be reported as a config
 * problem. Config-missing (ArchisignConfigError, thrown locally before
 * any network call) → 503 archisign_unconfigured. Upstream 5xx after
 * retries, or exhausted timeouts (httpStatus 0) → 503 archisign_unavailable
 * with a retry-later message.
 */
describe("POST /api/devis/:id/send-to-signer — outage vs config (Task #434)", () => {
  const VALID = { message: "Bonjour, voici le devis pour signature électronique." };

  it("maps a local config error to archisign_unconfigured", async () => {
    const { ArchisignConfigError } = await import("../../services/archisign");
    archisignMock.createEnvelope.mockRejectedValue(
      new ArchisignConfigError("ARCHISIGN_API_KEY is not configured"),
    );
    const res = await postSend(100, VALID);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("archisign_unconfigured");
    expect(body.message).toMatch(/not configured/);
  });

  it("maps an upstream 503 (outage) to archisign_unavailable, NOT unconfigured", async () => {
    const { ArchisignError } = await import("../../services/archisign");
    archisignMock.createEnvelope.mockRejectedValue(
      new ArchisignError("Archisign 503: Service Unavailable", 503, undefined, true),
    );
    const res = await postSend(100, VALID);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("archisign_unavailable");
    expect(body.message).toMatch(/momentanément indisponible/);
  });

  it("maps exhausted network retries (httpStatus 0) to archisign_unavailable", async () => {
    const { ArchisignError } = await import("../../services/archisign");
    archisignMock.createEnvelope.mockRejectedValue(
      new ArchisignError("Archisign network error after retries: timeout", 0, undefined, true),
    );
    const res = await postSend(100, VALID);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("archisign_unavailable");
  });

  it("keeps 4xx create failures on the generic 502 archisign_create_failed path", async () => {
    const { ArchisignError } = await import("../../services/archisign");
    archisignMock.createEnvelope.mockRejectedValue(
      new ArchisignError("Archisign 400: invalid_request", 400, undefined, false),
    );
    const res = await postSend(100, VALID);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("archisign_create_failed");
  });
});

describe("POST /api/devis/:id/send-to-signer — SEND-stage outage (Task #434)", () => {
  const VALID = { message: "Bonjour, voici le devis pour signature électronique." };

  it("maps an upstream 503 on sendEnvelope to archisign_unavailable (envelope preserved)", async () => {
    const { ArchisignError } = await import("../../services/archisign");
    archisignMock.sendEnvelope.mockRejectedValue(
      new ArchisignError("Archisign 503: Service Unavailable", 503, undefined, true),
    );
    const res = await postSend(100, VALID);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; message: string; archisignEnvelopeId: string };
    expect(body.code).toBe("archisign_unavailable");
    expect(body.message).toMatch(/momentanément indisponible/);
    // Resume path stays intact: the created envelope id is surfaced.
    expect(body.archisignEnvelopeId).toBe("env_42");
  });

  it("maps exhausted network retries on sendEnvelope to archisign_unavailable", async () => {
    const { ArchisignError } = await import("../../services/archisign");
    archisignMock.sendEnvelope.mockRejectedValue(
      new ArchisignError("Archisign network error after retries: timeout", 0, undefined, true),
    );
    const res = await postSend(100, VALID);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("archisign_unavailable");
  });

  it("keeps non-transient sendEnvelope failures on 502 archisign_send_failed", async () => {
    const { ArchisignError } = await import("../../services/archisign");
    archisignMock.sendEnvelope.mockRejectedValue(
      new ArchisignError("Archisign 400: invalid_request", 400, undefined, false),
    );
    const res = await postSend(100, VALID);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("archisign_send_failed");
  });
});
