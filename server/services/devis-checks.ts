import { createHash, randomBytes } from "node:crypto";
import { storage } from "../storage";
import type { DevisCheckToken } from "@shared/schema";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateRawToken(): string {
  // 32 bytes → 43 url-safe base64 chars; ample entropy for a portal token.
  return randomBytes(32).toString("base64url");
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
  });
  return { raw, record };
}

export async function lookupActiveToken(rawToken: string): Promise<DevisCheckToken | undefined> {
  const t = await storage.getDevisCheckTokenByHash(hashToken(rawToken));
  if (!t) return undefined;
  if (t.revokedAt) return undefined;
  return t;
}

export function buildPortalUrl(baseUrl: string, rawToken: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/p/check/${rawToken}`;
}
