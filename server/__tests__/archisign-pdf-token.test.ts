import { describe, it, expect, vi } from "vitest";

vi.mock("../env", () => ({
  env: { ARCHISIGN_PDF_TOKEN_SECRET: "unit-test-secret" },
}));

import { mintPdfFetchToken, verifyPdfFetchToken } from "../services/archisign-pdf-token";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

describe("archisign pdf fetch token (per-envelope pinning, task #378)", () => {
  it("round-trips the pinned storage key", () => {
    const token = mintPdfFetchToken(42, FUTURE, "translated/2026/devis-42.v3.pdf");
    const v = verifyPdfFetchToken(token);
    expect(v).not.toBeNull();
    expect(v!.devisId).toBe(42);
    expect(v!.pinnedStorageKey).toBe("translated/2026/devis-42.v3.pdf");
  });

  it("two envelopes for the same devis resolve to their OWN snapshots", () => {
    const t1 = mintPdfFetchToken(42, FUTURE, "snap/envelope-1.pdf");
    const t2 = mintPdfFetchToken(42, FUTURE, "snap/envelope-2.pdf");
    expect(verifyPdfFetchToken(t1)!.pinnedStorageKey).toBe("snap/envelope-1.pdf");
    expect(verifyPdfFetchToken(t2)!.pinnedStorageKey).toBe("snap/envelope-2.pdf");
  });

  it("rejects a token whose embedded key was tampered with", () => {
    const token = mintPdfFetchToken(42, FUTURE, "snap/original.pdf");
    const parts = token.split(".");
    parts[2] = Buffer.from("snap/attacker.pdf", "utf8").toString("base64url");
    expect(verifyPdfFetchToken(parts.join("."))).toBeNull();
  });

  it("rejects expired and malformed tokens", () => {
    const expired = mintPdfFetchToken(42, new Date(Date.now() - 1000), "snap/x.pdf");
    expect(verifyPdfFetchToken(expired)).toBeNull();
    expect(verifyPdfFetchToken("garbage")).toBeNull();
    expect(verifyPdfFetchToken("1.2.3.4.5")).toBeNull();
  });

  it("handles storage keys containing dots via base64url encoding", () => {
    const key = "a.b.c/d.e.pdf";
    const v = verifyPdfFetchToken(mintPdfFetchToken(7, FUTURE, key));
    expect(v!.pinnedStorageKey).toBe(key);
  });

  it("still accepts legacy v1 (3-part) tokens with a null pinned key", () => {
    // Reconstruct a v1 token: hmac over `${devisId}.${expiresAtMs}`.
    const crypto = require("crypto") as typeof import("crypto");
    const expiresAtMs = FUTURE.getTime();
    const mac = crypto.createHmac("sha256", "unit-test-secret").update(`42.${expiresAtMs}`).digest("hex");
    const v = verifyPdfFetchToken(`42.${expiresAtMs}.${mac}`);
    expect(v).not.toBeNull();
    expect(v!.pinnedStorageKey).toBeNull();
  });
});
