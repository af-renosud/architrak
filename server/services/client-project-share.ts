import { storage } from "../storage";
import { env } from "../env";
import type { ClientProjectShareToken, Devis } from "@shared/schema";
import {
  hashToken,
  generateRawToken,
  computeTokenExpiry,
  isTokenExpired,
} from "./client-checks";
import { encryptShareUrl, decryptShareUrl } from "./share-url-crypto";

export { encryptShareUrl, decryptShareUrl };

/**
 * Token plumbing for the project-scoped client share link (Task #388).
 * Mirrors `server/services/client-checks.ts` (per-devis client portal):
 * the raw token is never persisted — only its SHA-256 hash — and the TTL
 * reuses the same `DEVIS_CHECK_TOKEN_TTL_DAYS` knob so all client-facing
 * links share one sliding window policy.
 */

export { hashToken, generateRawToken, computeTokenExpiry, isTokenExpired };

export interface IssuedProjectShareToken {
  raw: string;
  record: ClientProjectShareToken;
}

export async function issueProjectShareToken(opts: {
  projectId: number;
  clientEmail: string;
  clientName: string | null;
  createdByUserId: number | null;
  /**
   * Task #407 — when provided, the full share URL is persisted encrypted
   * at rest so the authenticated panel can offer "Copy link" later. The
   * hash remains the only public lookup path.
   */
  publicBaseUrl?: string | null;
}): Promise<IssuedProjectShareToken> {
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const record = await storage.createProjectShareToken({
    projectId: opts.projectId,
    tokenHash,
    clientEmail: opts.clientEmail,
    clientName: opts.clientName ?? undefined,
    createdByUserId: opts.createdByUserId ?? undefined,
    expiresAt: computeTokenExpiry(),
    encryptedShareUrl: opts.publicBaseUrl
      ? encryptShareUrl(buildProjectShareUrl(opts.publicBaseUrl, raw))
      : undefined,
  });
  return { raw, record };
}

export type ProjectShareTokenLookup =
  | { ok: true; token: ClientProjectShareToken }
  | { ok: false; reason: "missing" | "revoked" | "expired" };

export async function resolveProjectShareToken(rawToken: string): Promise<ProjectShareTokenLookup> {
  const t = await storage.getProjectShareTokenByHash(hashToken(rawToken));
  if (!t) return { ok: false, reason: "missing" };
  if (t.revokedAt) return { ok: false, reason: "revoked" };
  if (isTokenExpired(t)) return { ok: false, reason: "expired" };
  return { ok: true, token: t };
}

export function buildProjectShareUrl(baseUrl: string, rawToken: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/p/client/project/${rawToken}`;
}

/**
 * Publishing gate (decisions locked with the user):
 *   • the devis must carry a FINALISED English translation — draft/edited is
 *     NOT enough (block untranslated / half-translated quotations);
 *   • void, provisional and superseded devis can never be published.
 * Signed / rejected devis remain publishable — they stay visible on the
 * link with a status badge.
 *
 * Returns null when publishable, otherwise a human-readable refusal.
 */
export async function getPublishBlockReason(devis: Devis): Promise<string | null> {
  if (devis.signOffStage === "void" || devis.status === "void") {
    return "This devis is void and cannot be shared with the client.";
  }
  if (devis.accountingState === "provisional") {
    return "This devis is still provisional (pending reconciliation) and cannot be shared yet.";
  }
  if (devis.accountingState === "superseded") {
    return "This devis has been superseded and cannot be shared with the client.";
  }
  const translation = await storage.getDevisTranslation(devis.id);
  if (!translation || translation.status !== "finalised") {
    return "The English translation must be finalised before this devis can be published to the client.";
  }
  return null;
}

/**
 * Render-time visibility filter for quotations already published. Stricter
 * than nothing but looser than the publish gate: a devis that later becomes
 * void / provisional / superseded silently drops off the client page even
 * though its membership row remains (defence in depth — the architect can
 * still unpublish explicitly). Translation state is NOT re-checked here:
 * unlocking a finalised translation for a wording tweak must not yank the
 * quotation off the client's page.
 */
export function isVisibleOnShareLink(devis: Devis): boolean {
  if (devis.signOffStage === "void" || devis.status === "void") return false;
  if (devis.accountingState === "provisional") return false;
  if (devis.accountingState === "superseded") return false;
  return true;
}

export function requirePublicBaseUrl(): string | null {
  return env.PUBLIC_BASE_URL || null;
}
