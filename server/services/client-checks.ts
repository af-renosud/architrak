import { createHash, randomBytes } from "node:crypto";
import { storage } from "../storage";
import { env } from "../env";
import type { ClientCheckToken } from "@shared/schema";
import { clientCheckTokens, projectCommunications } from "@shared/schema";
import { db } from "../db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { encryptCommunicationBody, redactClientLink } from "./communication-body-crypto";

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

export function clientLinkDeliveryDedupeKey(tokenId: number): string {
  return `devis-client-link:${tokenId}`;
}

export function canReuseClientLinkDelivery(
  token: Pick<ClientCheckToken, "revokedAt" | "expiresAt">,
  now: Date = new Date(),
): boolean {
  return !token.revokedAt && (!token.expiresAt || token.expiresAt.getTime() > now.getTime());
}

export function buildClientLinkEmail(opts: {
  projectName: string;
  devisRef: string;
  clientName: string | null;
  message: string;
  portalUrl: string;
}): { subject: string; body: string } {
  const safeRef = opts.devisRef.replace(/[\r\n]+/g, " ").trim();
  const safeProjectName = opts.projectName.replace(/[\r\n]+/g, " ").trim();
  const greeting = opts.clientName ? `Hello ${opts.clientName},` : "Hello,";
  return {
    subject: `Quotation ${safeRef} — ${safeProjectName}`,
    body: `${greeting}\n\n${opts.message.trim()}\n\nYou can review the quotation and send us your comments using this secure link:\n${opts.portalUrl}\n\nKind regards,\nThe Renosud team\n`,
  };
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

export async function issueClientCheckTokenEmail(opts: {
  devisId: number;
  projectId: number;
  projectName: string;
  devisRef: string;
  clientEmail: string;
  clientName: string | null;
  message: string;
  createdByUserId: number;
  baseUrl: string;
}): Promise<{
  record: ClientCheckToken;
  communication: typeof projectCommunications.$inferSelect;
  reused: boolean;
}> {
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const expiresAt = computeTokenExpiry();

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${opts.devisId}::bigint)`);
    const [active] = await tx
      .select()
      .from(clientCheckTokens)
      .where(and(eq(clientCheckTokens.devisId, opts.devisId), isNull(clientCheckTokens.revokedAt)))
      .limit(1);
    if (active && canReuseClientLinkDelivery(active)) {
      const [existingDelivery] = await tx
        .select()
        .from(projectCommunications)
        .where(eq(projectCommunications.dedupeKey, clientLinkDeliveryDedupeKey(active.id)))
        .limit(1);
      if (existingDelivery) {
        if (["queued", "sending", "failed"].includes(existingDelivery.status)) {
          return { record: active, communication: existingDelivery, reused: true };
        }
      }
    }

    await tx
      .update(clientCheckTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(clientCheckTokens.devisId, opts.devisId), isNull(clientCheckTokens.revokedAt)));
    const [record] = await tx
      .insert(clientCheckTokens)
      .values({
        devisId: opts.devisId,
        tokenHash,
        clientEmail: opts.clientEmail,
        clientName: opts.clientName ?? undefined,
        createdByUserId: opts.createdByUserId,
        expiresAt,
      })
      .returning();
    const portalUrl = buildClientPortalUrl(opts.baseUrl, raw);
    const email = buildClientLinkEmail({ ...opts, portalUrl });
    const [communication] = await tx
      .insert(projectCommunications)
      .values({
        projectId: opts.projectId,
        type: "devis_client_link",
        recipientType: "client",
        recipientEmail: opts.clientEmail,
        recipientName: opts.clientName,
        subject: email.subject,
        body: redactClientLink(email.body),
        encryptedBody: encryptCommunicationBody(email.body),
        status: "queued",
        dedupeKey: clientLinkDeliveryDedupeKey(record.id),
      })
      .returning();
    return { record, communication, reused: false };
  });
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
