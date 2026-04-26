/**
 * Stateless signed-token mint + verify for the public devis-PDF download
 * endpoint that Archisign fetches (AT4).
 *
 * Token format: `${devisId}.${expiresAtMs}.${hexHmacSha256}`
 *
 * The HMAC is keyed off ARCHISIGN_WEBHOOK_SECRET — reusing the existing
 * Archisign secret means there is one fewer secret to provision and
 * rotate, and the threat model is identical (any actor with the secret
 * can already forge inbound webhooks against us). If we ever need
 * separation of concerns we can split into a dedicated PDF_TOKEN_SECRET.
 *
 * Stateless because (a) the URL is single-use from Archisign's side
 * within a 1-hour window and (b) we want re-mint to be a pure function
 * of (devisId, expiry) so the architect can re-issue without a DB hop.
 */

import crypto from "crypto";
import { env } from "../env";

const SEPARATOR = ".";

function getSecret(): string {
  const s = env.ARCHISIGN_WEBHOOK_SECRET;
  if (!s) {
    throw new Error("ARCHISIGN_WEBHOOK_SECRET not configured — cannot mint PDF fetch token");
  }
  return s;
}

function hmac(devisId: number, expiresAtMs: number): string {
  return crypto
    .createHmac("sha256", getSecret())
    .update(`${devisId}${SEPARATOR}${expiresAtMs}`)
    .digest("hex");
}

export function mintPdfFetchToken(devisId: number, expiresAt: Date): string {
  const expiresAtMs = expiresAt.getTime();
  return `${devisId}${SEPARATOR}${expiresAtMs}${SEPARATOR}${hmac(devisId, expiresAtMs)}`;
}

export interface VerifiedPdfToken {
  devisId: number;
  expiresAt: Date;
}

export function verifyPdfFetchToken(token: string): VerifiedPdfToken | null {
  // Tolerate URL-percent-encoded tokens (Express decodes :param for us
  // already, but defensive split: 3 parts exactly).
  const parts = token.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const devisId = Number(parts[0]);
  const expiresAtMs = Number(parts[1]);
  const providedHex = parts[2];
  if (!Number.isFinite(devisId) || devisId <= 0) return null;
  if (!Number.isFinite(expiresAtMs)) return null;
  if (Date.now() > expiresAtMs) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) return null;
  let expectedHex: string;
  try {
    expectedHex = hmac(devisId, expiresAtMs);
  } catch {
    return null; // Secret unset — fail closed.
  }
  const provided = Buffer.from(providedHex.toLowerCase(), "hex");
  const expected = Buffer.from(expectedHex.toLowerCase(), "hex");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }
  return { devisId, expiresAt: new Date(expiresAtMs) };
}
