/**
 * Stateless signed-token mint + verify for the public devis-PDF download
 * endpoint that Archisign fetches (AT4).
 *
 * Token format: `${devisId}.${expiresAtMs}.${hexHmacSha256}`
 *
 * The HMAC is keyed off ARCHISIGN_PDF_TOKEN_SECRET — a dedicated secret
 * that is intentionally separate from ARCHISIGN_WEBHOOK_SECRET. Keeping
 * these secrets distinct ensures that a webhook-secret compromise does not
 * automatically grant read access to stored translated contract PDFs via
 * forged fetch tokens.
 *
 * If ARCHISIGN_PDF_TOKEN_SECRET is not set, getSecret() throws and both
 * mintPdfFetchToken and verifyPdfFetchToken fail closed — the send-to-signer
 * flow returns an error rather than silently falling back to the webhook
 * secret.
 *
 * Stateless because (a) the URL is single-use from Archisign's side
 * within a 1-hour window and (b) we want re-mint to be a pure function
 * of (devisId, expiry) so the architect can re-issue without a DB hop.
 */

import crypto from "crypto";
import { env } from "../env";

const SEPARATOR = ".";

function getSecret(): string {
  const s = env.ARCHISIGN_PDF_TOKEN_SECRET;
  if (!s) {
    throw new Error(
      "ARCHISIGN_PDF_TOKEN_SECRET not configured — cannot mint PDF fetch token. " +
        "Set a dedicated secret (separate from ARCHISIGN_WEBHOOK_SECRET) to enable " +
        "the Archisign PDF download endpoint.",
    );
  }
  return s;
}

function hmac(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("hex");
}

/**
 * Task #378 — v2 tokens bind the EXACT pinned PDF storage key into the
 * signed payload, so each envelope's fetch URL resolves to its own
 * immutable snapshot. A later re-send (new envelope, new pin) cannot
 * change what an earlier still-valid token serves, because the key
 * travels inside the token, HMAC-protected — not looked up on the devis.
 *
 * Format: `${devisId}.${expiresAtMs}.${base64url(pinnedStorageKey)}.${hexHmac}`
 * (base64url never contains ".", so the separator stays unambiguous even
 * though storage keys themselves may contain dots).
 *
 * Legacy v1 tokens (3 parts, no key) minted before this change are still
 * verified — envelopes already in flight keep working — and are flagged so
 * the public route can apply its legacy resolution path.
 */
export function mintPdfFetchToken(devisId: number, expiresAt: Date, pinnedStorageKey: string): string {
  const expiresAtMs = expiresAt.getTime();
  const keyB64 = Buffer.from(pinnedStorageKey, "utf8").toString("base64url");
  const payload = `${devisId}${SEPARATOR}${expiresAtMs}${SEPARATOR}${keyB64}`;
  return `${payload}${SEPARATOR}${hmac(payload)}`;
}

export interface VerifiedPdfToken {
  devisId: number;
  expiresAt: Date;
  /** Exact storage key pinned at mint time (v2 tokens). Null for legacy v1 tokens. */
  pinnedStorageKey: string | null;
}

export function verifyPdfFetchToken(token: string): VerifiedPdfToken | null {
  // Tolerate URL-percent-encoded tokens (Express decodes :param for us
  // already, but defensive split: 3 parts (legacy v1) or 4 parts (v2).
  const parts = token.split(SEPARATOR);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const devisId = Number(parts[0]);
  const expiresAtMs = Number(parts[1]);
  const keyB64 = parts.length === 4 ? parts[2] : null;
  const providedHex = parts[parts.length - 1];
  if (!Number.isFinite(devisId) || devisId <= 0) return null;
  if (!Number.isFinite(expiresAtMs)) return null;
  if (Date.now() > expiresAtMs) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) return null;
  if (keyB64 !== null && !/^[A-Za-z0-9_-]+$/.test(keyB64)) return null;
  const payload =
    keyB64 === null
      ? `${devisId}${SEPARATOR}${expiresAtMs}`
      : `${devisId}${SEPARATOR}${expiresAtMs}${SEPARATOR}${keyB64}`;
  let expectedHex: string;
  try {
    expectedHex = hmac(payload);
  } catch {
    return null; // Secret unset — fail closed.
  }
  const provided = Buffer.from(providedHex.toLowerCase(), "hex");
  const expected = Buffer.from(expectedHex.toLowerCase(), "hex");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }
  let pinnedStorageKey: string | null = null;
  if (keyB64 !== null) {
    pinnedStorageKey = Buffer.from(keyB64, "base64url").toString("utf8");
    if (!pinnedStorageKey) return null;
  }
  return { devisId, expiresAt: new Date(expiresAtMs), pinnedStorageKey };
}
