import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../env";
import { storage } from "../storage";
import { isTokenExpired } from "./client-checks";
import { decryptShareUrl } from "./share-url-crypto";

/**
 * Task #409 — server-to-server lookup of the live project client link for
 * ArchiDoc, keyed by ArchiDoc's own project id.
 *
 * Auth: inbound requests are signed with the shared ARCHIDOC_WEBHOOK_SECRET
 * using the same HMAC-SHA256 family as ArchiTrak's outbound pushes, but
 * over `${timestampMs}.${method}.${path}` (GET has no body). Headers:
 *   X-Archidoc-Timestamp: <ms epoch>
 *   X-Archidoc-Signature: sha256=<lowercase hex>
 * Replay window: ±5 minutes.
 *
 * The lookup NEVER mutates the token (no lastUsedAt touch, no rotation)
 * and the raw URL never enters logs or audit rows.
 */

export const ARCHIDOC_LOOKUP_REPLAY_WINDOW_MS = 5 * 60 * 1000;

export function computeLookupSignatureHex(secret: string, timestampMs: number, method: string, path: string): string {
  return createHmac("sha256", secret).update(`${timestampMs}.${method.toUpperCase()}.${path}`).digest("hex");
}

export type LookupAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; message: string };

export function verifyArchidocLookupSignature(opts: {
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  method: string;
  path: string;
  nowMs?: number;
}): LookupAuthResult {
  const secret = env.ARCHIDOC_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: false, status: 503, message: "ArchiDoc integration secret is not configured." };
  }
  const ts = Number(opts.timestampHeader);
  if (!opts.timestampHeader || !Number.isFinite(ts)) {
    return { ok: false, status: 401, message: "Missing or invalid X-Archidoc-Timestamp." };
  }
  const now = opts.nowMs ?? Date.now();
  if (Math.abs(now - ts) > ARCHIDOC_LOOKUP_REPLAY_WINDOW_MS) {
    return { ok: false, status: 401, message: "Timestamp outside the allowed window." };
  }
  const presented = opts.signatureHeader ?? "";
  if (!presented.startsWith("sha256=")) {
    return { ok: false, status: 401, message: "Missing or invalid X-Archidoc-Signature." };
  }
  const expected = computeLookupSignatureHex(secret, ts, opts.method, opts.path);
  const presentedHex = presented.slice("sha256=".length);
  const a = Buffer.from(presentedHex, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, message: "Signature mismatch." };
  }
  return { ok: true };
}

export type ArchidocLinkLookupResult =
  | { shareUrl: string; recipientEmail: string; expiresAt: string | null }
  | { shareUrl: null; reason: "unknown_project" | "no_active_link" | "expired" | "rotate_required" };

/**
 * Resolves the live share URL for the project correlated to the given
 * ArchiDoc project id. Read-only on the token. On success, records a
 * low-noise audit entry ("Lien fourni à ArchiDoc") at most once per
 * token per day; the URL itself never appears in the audit detail.
 */
export async function lookupClientShareLinkForArchidoc(archidocProjectId: string): Promise<ArchidocLinkLookupResult> {
  const project = await storage.getProjectByArchidocId(archidocProjectId);
  if (!project) return { shareUrl: null, reason: "unknown_project" };

  const active = await storage.getActiveProjectShareToken(project.id);
  if (!active) return { shareUrl: null, reason: "no_active_link" };
  if (isTokenExpired(active)) return { shareUrl: null, reason: "expired" };

  // Pre-encryption rows carry no recoverable URL (and so do rows whose
  // blob no longer authenticates after a SESSION_SECRET change).
  const url = active.encryptedShareUrl ? decryptShareUrl(active.encryptedShareUrl) : null;
  if (!url) return { shareUrl: null, reason: "rotate_required" };

  // Low-noise audit: at most one entry per token per calendar day (UTC).
  // Best-effort — an audit hiccup must never break the lookup itself.
  try {
    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    // Atomic check+insert (advisory-lock serialised) so concurrent lookups
    // can never write two rows for the same token on the same UTC day.
    await storage.createProjectShareAuditEntryIfAbsentSince({
      projectId: project.id,
      tokenId: active.id,
      action: "archidoc_lookup",
      detail: `Lien fourni à ArchiDoc pour ${active.clientEmail} (consultation automatique, aucune modification du lien).`,
    }, startOfDayUtc);
  } catch (err) {
    console.error("[archidoc-link-lookup] audit write failed (lookup still served):", err instanceof Error ? err.message : err);
  }

  return {
    shareUrl: url,
    recipientEmail: active.clientEmail,
    expiresAt: active.expiresAt ? active.expiresAt.toISOString() : null,
  };
}
