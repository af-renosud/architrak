import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Task #257 — contextual client email accompanying a devis signature
 * request.
 *
 * Pinned behaviours:
 *   (a) buildDevisContextEmailBody = architect message + separator +
 *       English Archisign notice referencing the devis + project
 *       (Task #266 — all client-facing copy is English).
 *   (b) Happy path logs a `devis_signature_context` communication with the
 *       (devis, envelope) dedupeKey and reports status "sent".
 *   (c) Same (devis, envelope) with an already-sent row → "already_sent",
 *       no second Gmail send.
 *   (d) Gmail failure → status "failed" (never throws), row marked failed.
 *   (e) Missing client email on the project → "failed", nothing created.
 */

const { state, storageSpy, gmailSpy } = vi.hoisted(() => {
  const state = {
    devis: {
      id: 7,
      projectId: 3,
      devisNumber: "DVT0000941",
      devisCode: "LOT05-001",
    },
    project: {
      id: 3,
      name: "Villa Sophia",
      clientName: "SCI Sophia",
      clientContactName: "Marie Dupont",
      clientContactEmail: "marie@example.test",
    } as Record<string, unknown>,
    comms: [] as Array<Record<string, unknown> & { id: number; status: string }>,
    nextId: 1,
    gmailShouldFail: false,
  };
  const gmailSpy = {
    send: vi.fn(async () => {
      if (state.gmailShouldFail) throw new Error("gmail boom");
      return { data: { id: "msg_1", threadId: "thr_1" } };
    }),
  };
  const storageSpy = {
    getDevis: vi.fn(async () => state.devis),
    getProject: vi.fn(async () => state.project),
    getProjectCommunicationByDedupeKey: vi.fn(async (key: string) =>
      state.comms.find((c) => c.dedupeKey === key),
    ),
    createProjectCommunication: vi.fn(async (data: Record<string, unknown>) => {
      const row = { ...data, id: state.nextId++, status: (data.status as string) ?? "draft" };
      state.comms.push(row);
      return row;
    }),
    getProjectCommunication: vi.fn(async (id: number) => state.comms.find((c) => c.id === id)),
    // Task #466 — sendCommunication now prefers a linked per-user Gmail
    // client; no linked users in this suite → falls back to the connector.
    listGmailPollingUsers: vi.fn(async () => []),
    updateProjectCommunication: vi.fn(async (id: number, patch: Record<string, unknown>) => {
      const row = state.comms.find((c) => c.id === id);
      if (row) Object.assign(row, patch);
      return row;
    }),
  };
  return { state, storageSpy, gmailSpy };
});

vi.mock("../../storage", () => ({ storage: storageSpy }));
vi.mock("../../gmail/client", () => ({
  isGmailConfigured: () => true,
  isFakeGmailMode: () => false,
  getUncachableGmailClient: vi.fn(async () => ({
    users: { messages: { send: gmailSpy.send } },
  })),
}));
vi.mock("../../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(),
  uploadDocument: vi.fn(),
}));
vi.mock("../certificat-generator", () => ({
  generateCertificatPdf: vi.fn(),
  buildCertificatEmailBody: vi.fn(),
}));
vi.mock("../../env", () => ({ env: {} }));

import {
  buildDevisContextEmailBody,
  sendDevisSignatureContextEmail,
  loadAssetAttachment,
  SIGNING_EXPLAINER_ATTACHMENT_KEY,
} from "../email-sender";

beforeEach(() => {
  vi.clearAllMocks();
  state.comms = [];
  state.nextId = 1;
  state.gmailShouldFail = false;
  state.project.clientContactEmail = "marie@example.test";
});

describe("buildDevisContextEmailBody", () => {
  it("keeps the architect message first and appends the English Archisign notice", () => {
    const body = buildDevisContextEmailBody({
      architectMessage: "  Dear Marie,\n\nHere is the devis.\n\nKind regards,  ",
      refLabel: "DVT0000941",
      projectName: "Villa Sophia",
    });
    expect(body.startsWith("Dear Marie,")).toBe(true);
    expect(body).toContain("\n\n---\n\n");
    expect(body).not.toContain("e-mail séparé d'Archisign");
    expect(body).toContain("separate email from Archisign");
    // Task #442 — fixed payment warning, guaranteed outside the architect text.
    expect(body).toContain("Don't pay anything now. At this stage, you are only authorising the quotation.");
    expect(body.indexOf("---")).toBeLessThan(body.indexOf("Don't pay anything now"));
    expect(body).toContain("DVT0000941");
    expect(body).toContain("Villa Sophia");
  });
});

describe("sendDevisSignatureContextEmail", () => {
  it("logs a devis_signature_context communication and sends it", async () => {
    const result = await sendDevisSignatureContextEmail({
      devisId: 7,
      envelopeId: "env_42",
      message: "Bonjour Marie, voici le devis pour signature.",
    });
    expect(result.status).toBe("sent");
    expect(result.communicationId).toBe(1);
    expect(gmailSpy.send).toHaveBeenCalledTimes(1);
    const created = storageSpy.createProjectCommunication.mock.calls[0][0] as Record<string, unknown>;
    expect(created.type).toBe("devis_signature_context");
    expect(created.recipientEmail).toBe("marie@example.test");
    expect(created.dedupeKey).toBe("devis-signature-context:7:env_42");
    expect(created.subject).toContain("DVT0000941");
  });

  it("is idempotent per (devis, envelope): already-sent row short-circuits", async () => {
    state.comms.push({
      id: 55,
      status: "sent",
      dedupeKey: "devis-signature-context:7:env_42",
    });
    const result = await sendDevisSignatureContextEmail({
      devisId: 7,
      envelopeId: "env_42",
      message: "Bonjour Marie, voici le devis pour signature.",
    });
    expect(result).toEqual({ communicationId: 55, status: "already_sent" });
    expect(gmailSpy.send).not.toHaveBeenCalled();
    expect(storageSpy.createProjectCommunication).not.toHaveBeenCalled();
  });

  it("retries a previously failed row instead of creating a duplicate", async () => {
    state.comms.push({
      id: 56,
      status: "failed",
      dedupeKey: "devis-signature-context:7:env_42",
      recipientEmail: "marie@example.test",
      subject: "s",
      body: "b",
    });
    const result = await sendDevisSignatureContextEmail({
      devisId: 7,
      envelopeId: "env_42",
      message: "Bonjour Marie, voici le devis pour signature.",
    });
    expect(result.status).toBe("sent");
    expect(result.communicationId).toBe(56);
    expect(storageSpy.createProjectCommunication).not.toHaveBeenCalled();
    expect(gmailSpy.send).toHaveBeenCalledTimes(1);
  });

  it("returns failed (never throws) when the Gmail send blows up", async () => {
    state.gmailShouldFail = true;
    const result = await sendDevisSignatureContextEmail({
      devisId: 7,
      envelopeId: "env_42",
      message: "Bonjour Marie, voici le devis pour signature.",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/gmail boom/);
    // The communication row exists and is marked failed for later retry.
    expect(state.comms[0].status).toBe("failed");
  });

  it("returns failed when the project has no client contact email", async () => {
    state.project.clientContactEmail = "  ";
    const result = await sendDevisSignatureContextEmail({
      devisId: 7,
      envelopeId: "env_42",
      message: "Bonjour Marie, voici le devis pour signature.",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Client contact email missing/);
    expect(storageSpy.createProjectCommunication).not.toHaveBeenCalled();
  });
});

/**
 * Task #443 — the standard one-page explainer PDF ("How signing and
 * payment works") accompanies every signature-context email as a bundled
 * static asset. Kept out of the Archisign signing package by design.
 */
describe("signing explainer attachment (Task #443)", () => {
  it("creates the communication with the bundled explainer asset key", async () => {
    const result = await sendDevisSignatureContextEmail({
      devisId: 7,
      envelopeId: "env_43",
      message: "Bonjour Marie, voici le devis pour signature.",
    });
    expect(result.status).toBe("sent");
    const row = state.comms[0];
    expect(row.attachmentStorageKeys).toEqual([SIGNING_EXPLAINER_ATTACHMENT_KEY]);
    // The Gmail raw payload must carry the attachment with the client-facing filename.
    const raw = (gmailSpy.send.mock.calls[0][0] as { requestBody: { raw: string } }).requestBody.raw;
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain('filename="How-signing-and-payment-works.pdf"');
    expect(decoded).toContain("Content-Type: application/pdf");
  });

  it("loadAssetAttachment returns the real one-page PDF from server/assets", () => {
    const asset = loadAssetAttachment(SIGNING_EXPLAINER_ATTACHMENT_KEY);
    expect(asset.filename).toBe("How-signing-and-payment-works.pdf");
    expect(asset.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(asset.buffer.length).toBeGreaterThan(10_000);
  });

  it("throws on an unknown asset key instead of silently attaching nothing", () => {
    expect(() => loadAssetAttachment("asset:nope.pdf")).toThrow(/Unknown bundled asset/);
  });

  it("merges the explainer key into a legacy failed row before retrying (and attaches it)", async () => {
    // Legacy row: queued before Task #443, no attachments, failed send.
    state.comms.push({
      id: state.nextId++,
      projectId: 3,
      type: "devis_signature_context",
      recipientEmail: "marie@example.test",
      subject: "old subject",
      body: "old body",
      attachmentStorageKeys: null,
      status: "failed",
      dedupeKey: "devis-signature-context:7:env_legacy",
    });
    const result = await sendDevisSignatureContextEmail({
      devisId: 7,
      envelopeId: "env_legacy",
      message: "Bonjour Marie, voici le devis pour signature.",
    });
    expect(result.status).toBe("sent");
    const row = state.comms.find((c) => c.dedupeKey === "devis-signature-context:7:env_legacy")!;
    expect(row.attachmentStorageKeys).toEqual([SIGNING_EXPLAINER_ATTACHMENT_KEY]);
    const raw = (gmailSpy.send.mock.calls[0][0] as { requestBody: { raw: string } }).requestBody.raw;
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain('filename="How-signing-and-payment-works.pdf"');
  });
});
