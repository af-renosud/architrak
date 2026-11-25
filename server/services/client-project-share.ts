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
import { quotationActionDecision } from "./quotation-approval-guard";
import { evaluateQuotationDecision } from "./quotation-decision";
import { readQuotationDecisionSnapshot } from "./quotation-decision-snapshot";
import { db } from "../db";
import { and, eq, sql } from "drizzle-orm";
import { clientProjectShareTokens, clientProjectShareDevis, clientProjectShareAudit } from "@shared/schema";
import {
  ClientReleaseChangedError,
  commitClientRelease,
  getLatestClientRelease,
  lockClientContent,
  prepareClientRelease,
  readClientContentVersion,
} from "./client-quotation-release";

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
  const decision = await quotationActionDecision(devis.id, "client_link");
  return decision.issues.find(i => i.severity === "blocker")?.message ?? null;
}

/** Publication is a decision AND a write under the quotation and token locks.
 * Editing approval/context, replacement and token rotation cannot race disclosure. */
export async function publishReviewedQuotation(projectId: number, tokenId: number, devisId: number, actorUserId: number | null) {
  // Cheap gate first so a blocked publish never waits for package generation.
  const early = await quotationActionDecision(devisId, "client_link");
  if (!early.allowed) return { ok: false as const, message: early.issues.find(i => i.severity === "blocker")!.message, decision: early };
  // Seal the client copy BEFORE taking locks (package generation can take a
  // minute); the commit below proves the content is still that version.
  const latest = await getLatestClientRelease(devisId);
  const currentVersion = await readClientContentVersion(db, devisId);
  const prepared = latest && latest.contentVersion === currentVersion ? null : await prepareClientRelease(devisId);
  try {
    return await db.transaction(async tx => {
      await lockClientContent(tx, devisId);
      const [token] = await tx.select().from(clientProjectShareTokens).where(and(
        eq(clientProjectShareTokens.id, tokenId), eq(clientProjectShareTokens.projectId, projectId))).for("share");
      if (!token || token.revokedAt || isTokenExpired(token)) return { ok: false as const, message: "Client link changed or expired. Refresh before publishing." };
      await tx.execute(sql`SELECT id FROM projects WHERE id=${projectId} FOR SHARE`);
      const snapshot = await readQuotationDecisionSnapshot(tx, devisId);
      if (!snapshot || snapshot.quotation.projectId !== projectId) return { ok: false as const, message: "Quotation not found in this project." };
      const decision = await evaluateQuotationDecision(snapshot, "client_link");
      if (!decision.allowed) return { ok: false as const, message: decision.issues.find(i => i.severity === "blocker")!.message, decision };
      const release = prepared
        ? await commitClientRelease(tx, prepared, "publish", actorUserId)
        : await getLatestClientRelease(devisId, tx);
      if (!release || release.contentVersion !== decision.contentVersion) throw new ClientReleaseChangedError();
      const inserted = await tx.insert(clientProjectShareDevis).values({ tokenId, devisId, publishedByUserId: actorUserId })
        .onConflictDoNothing().returning();
      if (inserted.length || prepared) await tx.insert(clientProjectShareAudit).values({ projectId, tokenId, devisId, actorUserId,
        action: "publish", detail: `Devis ${snapshot.quotation.devisCode} publié après vérification de la version ${decision.version} — copie client scellée n°${release.id} (PDF SHA-256 ${release.packageSha256 ?? "—"}).` });
      return { ok: true as const, releaseId: release.id };
    });
  } catch (err) {
    if (err instanceof ClientReleaseChangedError) return { ok: false as const, message: err.message };
    throw err;
  }
}

/** True when a client can currently reach this quotation's working content
 * (published on an active project link, or an active per-quotation link). */
export async function isQuotationClientVisible(devisId: number): Promise<boolean> {
  const r = await db.execute(sql`SELECT
    EXISTS (SELECT 1 FROM client_project_share_devis m JOIN client_project_share_tokens t ON t.id=m.token_id
      WHERE m.devis_id=${devisId} AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()))
    OR EXISTS (SELECT 1 FROM client_check_tokens c
      WHERE c.devis_id=${devisId} AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())) AS visible`);
  return r.rows[0]?.visible === true;
}

/**
 * Replace what the client sees with a newly sealed copy of the CURRENT,
 * reviewed content. Same approval gate as publishing; the previous copies
 * remain on record.
 */
export async function updateClientCopy(devisId: number, actorUserId: number | null) {
  if (!await isQuotationClientVisible(devisId)) {
    return { ok: false as const, message: "This quotation is not currently shared with the client." };
  }
  const early = await quotationActionDecision(devisId, "client_link");
  if (!early.allowed) return { ok: false as const, message: early.issues.find(i => i.severity === "blocker")!.message, decision: early };
  const latest = await getLatestClientRelease(devisId);
  if (latest && latest.contentVersion === await readClientContentVersion(db, devisId)) {
    return { ok: true as const, releaseId: latest.id, unchanged: true };
  }
  const prepared = await prepareClientRelease(devisId);
  try {
    return await db.transaction(async tx => {
      await lockClientContent(tx, devisId);
      const snapshot = await readQuotationDecisionSnapshot(tx, devisId);
      if (!snapshot) return { ok: false as const, message: "Quotation not found." };
      const decision = await evaluateQuotationDecision(snapshot, "client_link");
      if (!decision.allowed) return { ok: false as const, message: decision.issues.find(i => i.severity === "blocker")!.message, decision };
      const release = await commitClientRelease(tx, prepared, "update", actorUserId);
      await tx.insert(clientProjectShareAudit).values({ projectId: snapshot.quotation.projectId, devisId, actorUserId,
        action: "update_copy", detail: `Copie client du devis ${snapshot.quotation.devisCode} mise à jour après vérification de la version ${decision.version} — copie scellée n°${release.id} (PDF SHA-256 ${release.packageSha256 ?? "—"}).` });
      return { ok: true as const, releaseId: release.id, unchanged: false };
    });
  } catch (err) {
    if (err instanceof ClientReleaseChangedError) return { ok: false as const, message: err.message };
    throw err;
  }
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
  if (devis.signOffStage === "void" || ["void", "cancelled", "superseded"].includes(devis.status)) return false;
  if (devis.accountingState === "provisional") return false;
  if (devis.accountingState === "superseded") return false;
  return true;
}

export function requirePublicBaseUrl(): string | null {
  return env.PUBLIC_BASE_URL || null;
}
