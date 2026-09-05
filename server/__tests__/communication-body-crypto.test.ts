import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../env", () => ({
  env: { SESSION_SECRET: "test-session-secret" },
}));

let crypto: typeof import("../services/communication-body-crypto");

beforeAll(async () => {
  crypto = await import("../services/communication-body-crypto");
});

describe("protected quotation email bodies", () => {
  const body = "Bonjour\nhttps://example.test/p/client/raw_bearer-token\nCordialement";

  it("encrypts the exact retry body and redacts the history copy", () => {
    const encrypted = crypto.encryptCommunicationBody(body);
    expect(encrypted).not.toContain("raw_bearer-token");
    expect(crypto.decryptCommunicationBody(encrypted)).toBe(body);
    expect(crypto.redactClientLink(body)).toBe(
      `Bonjour\n${crypto.PROTECTED_CLIENT_LINK_LABEL}\nCordialement`,
    );
  });

  it("rejects malformed or modified ciphertext", () => {
    expect(crypto.decryptCommunicationBody("bad")).toBeNull();
    const encrypted = crypto.encryptCommunicationBody(body);
    expect(crypto.decryptCommunicationBody(`${encrypted}x`)).toBeNull();
  });

  it("extracts the server-only portal URL", () => {
    expect(crypto.extractClientPortalUrl(body)).toBe(
      "https://example.test/p/client/raw_bearer-token",
    );
    expect(crypto.extractClientPortalUrl(crypto.redactClientLink(body))).toBeNull();
  });
});