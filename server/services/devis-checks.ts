import { createHash, randomBytes } from "node:crypto";
import { storage } from "../storage";
import { env } from "../env";
import type { DevisCheckToken } from "@shared/schema";

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
 * expires automatically.
 */
export function computeTokenExpiry(from: Date = new Date()): Date | null {
  const days = env.DEVIS_CHECK_TOKEN_TTL_DAYS;
  if (!days || days <= 0) return null;
  const out = new Date(from);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** True when a token has an expiry in the past. */
export function isTokenExpired(token: Pick<DevisCheckToken, "expiresAt">, now: Date = new Date()): boolean {
  return !!token.expiresAt && token.expiresAt.getTime() <= now.getTime();
}

export interface IssuedToken {
  raw: string;
  record: DevisCheckToken;
}

export async function issueDevisCheckToken(opts: {
  devisId: number;
  contractorId: number;
  contractorEmail: string;
  createdByUserId: number | null;
}): Promise<IssuedToken> {
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const record = await storage.createDevisCheckToken({
    devisId: opts.devisId,
    tokenHash,
    contractorId: opts.contractorId,
    contractorEmail: opts.contractorEmail,
    createdByUserId: opts.createdByUserId ?? undefined,
    expiresAt: computeTokenExpiry(),
  });
  return { raw, record };
}

export type TokenLookup =
  | { ok: true; token: DevisCheckToken }
  | { ok: false; reason: "missing" | "revoked" | "expired" };

/**
 * Resolve a raw token to its DB record. Returns a tagged result so callers
 * can distinguish "never existed" from "expired" and surface the right page.
 */
export async function resolveDevisCheckToken(rawToken: string): Promise<TokenLookup> {
  const t = await storage.getDevisCheckTokenByHash(hashToken(rawToken));
  if (!t) return { ok: false, reason: "missing" };
  if (t.revokedAt) return { ok: false, reason: "revoked" };
  if (isTokenExpired(t)) return { ok: false, reason: "expired" };
  return { ok: true, token: t };
}

export async function lookupActiveToken(rawToken: string): Promise<DevisCheckToken | undefined> {
  const r = await resolveDevisCheckToken(rawToken);
  return r.ok ? r.token : undefined;
}

export function buildPortalUrl(baseUrl: string, rawToken: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/p/check/${rawToken}`;
}
