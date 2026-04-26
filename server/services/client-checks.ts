import { createHash, randomBytes } from "node:crypto";
import { storage } from "../storage";
import { env } from "../env";
import type { ClientCheckToken } from "@shared/schema";

/**
 * Token plumbing for the AT2 client review portal — mirror of the
 * contractor-facing `server/services/devis-checks.ts` but for `client_check_*`
 * tables. The two services are intentionally kept separate so the architect
 * can ship a token to the client without affecting the contractor's portal
 * link (and vice versa). Per contract §2.1.3 the raw token is never persisted;
 * only its SHA-256 hash lands in `client_check_tokens.token_hash`.
 */

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateRawToken(): string {
  // 32 bytes → 43 url-safe base64 chars; ample entropy for a portal token.
  return randomBytes(32).toString("base64url");
}

/**
 * Compute the expiry timestamp for a token whose sliding window starts at
 * `from`. Returns null when TTL is disabled (set to 0) so the token never
 * expires automatically. Reuses `DEVIS_CHECK_TOKEN_TTL_DAYS` so operators
 * tune one knob for both portals — the client review window naturally tracks
 * the contractor query window.
 */
export function computeTokenExpiry(from: Date = new Date()): Date | null {
  const days = env.DEVIS_CHECK_TOKEN_TTL_DAYS;
  if (!days || days <= 0) return null;
  const out = new Date(from);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** True when a token has an expiry in the past. */
export function isTokenExpired(
  token: Pick<ClientCheckToken, "expiresAt">,
  now: Date = new Date(),
): boolean {
  return !!token.expiresAt && token.expiresAt.getTime() <= now.getTime();
}

export interface IssuedClientToken {
  raw: string;
  record: ClientCheckToken;
}

export async function issueClientCheckToken(opts: {
  devisId: number;
  clientEmail: string;
  clientName: string | null;
  createdByUserId: number | null;
}): Promise<IssuedClientToken> {
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const record = await storage.createClientCheckToken({
    devisId: opts.devisId,
    tokenHash,
    clientEmail: opts.clientEmail,
    clientName: opts.clientName ?? undefined,
    createdByUserId: opts.createdByUserId ?? undefined,
    expiresAt: computeTokenExpiry(),
  });
  return { raw, record };
}

export type ClientTokenLookup =
  | { ok: true; token: ClientCheckToken }
  | { ok: false; reason: "missing" | "revoked" | "expired" };

/**
 * Resolve a raw token to its DB record. Returns a tagged result so callers
 * can distinguish "never existed" from "expired" and surface the right page.
 */
export async function resolveClientCheckToken(rawToken: string): Promise<ClientTokenLookup> {
  const t = await storage.getClientCheckTokenByHash(hashToken(rawToken));
  if (!t) return { ok: false, reason: "missing" };
  if (t.revokedAt) return { ok: false, reason: "revoked" };
  if (isTokenExpired(t)) return { ok: false, reason: "expired" };
  return { ok: true, token: t };
}

export function buildClientPortalUrl(baseUrl: string, rawToken: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/p/client/${rawToken}`;
}
