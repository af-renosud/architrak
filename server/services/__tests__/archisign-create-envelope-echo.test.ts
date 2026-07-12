import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Coverage for the contract §3.5.1.1(c) `emailRendering` echo (in force
 * since 2026-07-13, countersigned 2026-07-12) on
 * createEnvelope (Task #277).
 *
 * Pinned behaviours:
 *   (a) Pre-v1.2 servers — no `emailRendering` in the /create 201 — parse
 *       fine and return `emailRendering: undefined` with no warning.
 *   (b) A well-formed echo is surfaced on the flattened response.
 *   (c) `subjectApplied: false` for a non-empty sent subject logs the
 *       operator-visible drift warning but does NOT fail the call.
 *   (d) A malformed echo degrades to "not present" (`.catch(undefined)`)
 *       instead of failing the whole /create parse — the envelope exists.
 */

vi.mock("../../env", () => ({
  env: {
    ARCHISIGN_BASE_URL: "https://archisign.test",
    ARCHISIGN_API_KEY: "key_test",
  },
}));

import { createEnvelope, buildArchisignEnvelopeSubject } from "../archisign";

const wireBase = {
  envelopeId: 42,
  status: "draft",
  createdAt: "2026-07-12T10:00:00.000Z",
  expiresAt: "2026-08-11T10:00:00.000Z",
  signers: [
    {
      id: 1,
      accessToken: "tok_signer",
      accessUrl: "https://archisign.test/e/42",
      otpDestination: "+33 6 00 00 00 00",
    },
  ],
};

function mockCreateResponse(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function basePayload() {
  return {
    externalRef: "devis-100",
    signer: { fullName: "Marie Dupont", email: "marie@example.test" },
    pdfFetchUrl: "https://architrak.test/pdf?tok=abc",
    webhookUrl: "https://architrak.test/api/webhooks/archisign",
    subject: buildArchisignEnvelopeSubject("LOT01-001"),
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("createEnvelope — §3.5.1.1(c) emailRendering echo", () => {
  it("tolerates a pre-v1.2 response with no emailRendering (no warning)", async () => {
    mockCreateResponse(wireBase);
    const resp = await createEnvelope(basePayload());
    expect(resp.envelopeId).toBe("42");
    expect(resp.emailRendering).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("surfaces a well-formed echo on the flattened response", async () => {
    mockCreateResponse({
      ...wireBase,
      emailRendering: { subjectApplied: true, bodyApplied: false },
    });
    const resp = await createEnvelope(basePayload());
    expect(resp.emailRendering).toEqual({ subjectApplied: true, bodyApplied: false });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns (non-fatally) when subjectApplied=false for a non-empty sent subject", async () => {
    mockCreateResponse({
      ...wireBase,
      emailRendering: { subjectApplied: false, bodyApplied: false },
    });
    const resp = await createEnvelope(basePayload());
    // The call still succeeds — the envelope exists and the flow proceeds.
    expect(resp.envelopeId).toBe("42");
    expect(resp.emailRendering).toEqual({ subjectApplied: false, bodyApplied: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain("subjectApplied=false");
    expect(msg).toContain("envelope 42");
    expect(msg).toContain("§3.5.1.1(c)");
  });

  it("does not warn on subjectApplied=false when no subject was sent", async () => {
    mockCreateResponse({
      ...wireBase,
      emailRendering: { subjectApplied: false, bodyApplied: false },
    });
    const payload = basePayload();
    delete (payload as { subject?: string }).subject;
    const resp = await createEnvelope(payload);
    expect(resp.envelopeId).toBe("42");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("degrades a malformed echo to 'not present' instead of failing /create", async () => {
    mockCreateResponse({
      ...wireBase,
      emailRendering: { subjectApplied: "yes", bodyApplied: 1 },
    });
    const resp = await createEnvelope(basePayload());
    expect(resp.envelopeId).toBe("42");
    expect(resp.emailRendering).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("tolerates extra keys inside a valid echo (forward-compatible)", async () => {
    mockCreateResponse({
      ...wireBase,
      emailRendering: { subjectApplied: true, bodyApplied: true, templateVersion: "v9" },
    });
    const resp = await createEnvelope(basePayload());
    expect(resp.emailRendering).toEqual({ subjectApplied: true, bodyApplied: true });
  });

  // Task #283 — body half of the echo, under the in-force §3.5.1.1(b)
  // RENDERED election (countersigned 2026-07-12, in force 2026-07-13).
  it("warns (non-fatally) when bodyApplied=false for a non-empty sent body", async () => {
    mockCreateResponse({
      ...wireBase,
      emailRendering: { subjectApplied: true, bodyApplied: false },
    });
    const resp = await createEnvelope({
      ...basePayload(),
      body: "Bonjour, voici le devis pour signature.",
    });
    expect(resp.envelopeId).toBe("42");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain("bodyApplied=false");
    expect(msg).toContain("envelope 42");
    expect(msg).toContain("§3.5.1.1(b)");
  });

  it("does not warn on bodyApplied=false when no body was sent (clause-correct echo)", async () => {
    mockCreateResponse({
      ...wireBase,
      emailRendering: { subjectApplied: true, bodyApplied: false },
    });
    const resp = await createEnvelope(basePayload());
    expect(resp.envelopeId).toBe("42");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn on bodyApplied=false for a whitespace-only body", async () => {
    mockCreateResponse({
      ...wireBase,
      emailRendering: { subjectApplied: true, bodyApplied: false },
    });
    const resp = await createEnvelope({ ...basePayload(), body: "   \n\t " });
    expect(resp.envelopeId).toBe("42");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns twice when BOTH halves drift (subject and body each get their own warning)", async () => {
    mockCreateResponse({
      ...wireBase,
      emailRendering: { subjectApplied: false, bodyApplied: false },
    });
    const resp = await createEnvelope({
      ...basePayload(),
      body: "Bonjour, voici le devis pour signature.",
    });
    expect(resp.envelopeId).toBe("42");
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("subjectApplied=false"))).toBe(true);
    expect(messages.some((m) => m.includes("bodyApplied=false"))).toBe(true);
  });
});
