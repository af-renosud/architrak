import { describe, it, expect } from "vitest";
import {
  computeLookupSignatureHex,
  verifyArchidocLookupSignature,
  ARCHIDOC_LOOKUP_REPLAY_WINDOW_MS,
} from "../services/archidoc-link-lookup";
import { env } from "../env";

/**
 * Task #409 — HMAC verification for the ArchiDoc client-link lookup.
 * Signature = HMAC-SHA256(secret, `${ts}.${METHOD}.${path}`), headers
 * X-Archidoc-Timestamp / X-Archidoc-Signature, ±5 min replay window.
 */

const PATH = "/integrations/archidoc/projects/ad-42/client-share-link";

function signedHeaders(ts: number, secret: string = env.ARCHIDOC_WEBHOOK_SECRET!) {
  return {
    timestampHeader: String(ts),
    signatureHeader: `sha256=${computeLookupSignatureHex(secret, ts, "GET", PATH)}`,
  };
}

const hasSecret = !!env.ARCHIDOC_WEBHOOK_SECRET;

describe("verifyArchidocLookupSignature (Task #409)", () => {
  it.skipIf(!hasSecret)("accepts a correctly signed request", () => {
    const now = Date.now();
    const res = verifyArchidocLookupSignature({ ...signedHeaders(now), method: "GET", path: PATH, nowMs: now });
    expect(res.ok).toBe(true);
  });

  it.skipIf(!hasSecret)("rejects a bad signature", () => {
    const now = Date.now();
    const h = signedHeaders(now);
    const res = verifyArchidocLookupSignature({
      timestampHeader: h.timestampHeader,
      signatureHeader: "sha256=" + "0".repeat(64),
      method: "GET",
      path: PATH,
      nowMs: now,
    });
    expect(res).toEqual({ ok: false, status: 401, message: "Signature mismatch." });
  });

  it.skipIf(!hasSecret)("rejects a signature computed over a different path", () => {
    const now = Date.now();
    const other = `sha256=${computeLookupSignatureHex(env.ARCHIDOC_WEBHOOK_SECRET!, now, "GET", "/integrations/archidoc/projects/OTHER/client-share-link")}`;
    const res = verifyArchidocLookupSignature({
      timestampHeader: String(now),
      signatureHeader: other,
      method: "GET",
      path: PATH,
      nowMs: now,
    });
    expect(res.ok).toBe(false);
  });

  it.skipIf(!hasSecret)("rejects stale timestamps beyond the replay window", () => {
    const now = Date.now();
    const stale = now - ARCHIDOC_LOOKUP_REPLAY_WINDOW_MS - 1000;
    const res = verifyArchidocLookupSignature({ ...signedHeaders(stale), method: "GET", path: PATH, nowMs: now });
    expect(res).toEqual({ ok: false, status: 401, message: "Timestamp outside the allowed window." });
  });

  it.skipIf(!hasSecret)("rejects future timestamps beyond the replay window", () => {
    const now = Date.now();
    const future = now + ARCHIDOC_LOOKUP_REPLAY_WINDOW_MS + 1000;
    const res = verifyArchidocLookupSignature({ ...signedHeaders(future), method: "GET", path: PATH, nowMs: now });
    expect(res.ok).toBe(false);
  });

  it.skipIf(!hasSecret)("rejects missing or malformed headers", () => {
    const now = Date.now();
    expect(verifyArchidocLookupSignature({ timestampHeader: undefined, signatureHeader: undefined, method: "GET", path: PATH, nowMs: now }).ok).toBe(false);
    expect(verifyArchidocLookupSignature({ timestampHeader: "not-a-number", signatureHeader: "sha256=abc", method: "GET", path: PATH, nowMs: now }).ok).toBe(false);
    const h = signedHeaders(now);
    // Signature without the sha256= prefix is refused.
    expect(verifyArchidocLookupSignature({
      timestampHeader: h.timestampHeader,
      signatureHeader: h.signatureHeader.slice("sha256=".length),
      method: "GET",
      path: PATH,
      nowMs: now,
    }).ok).toBe(false);
  });
});
