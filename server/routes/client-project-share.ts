import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import { env } from "../env";
import {
  issueProjectShareToken,
  buildProjectShareUrl,
  computeTokenExpiry,
  isTokenExpired,
  getPublishBlockReason,
} from "../services/client-project-share";

const router = Router();

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });

const issueSchema = z.object({
  clientEmail: z.string().email(),
  clientName: z.string().max(200).optional(),
}).strict();

const devisRefSchema = z.object({
  devisId: z.number().int().positive(),
}).strict();

// NOTE: mounted at the application root in routes/index.ts; every route is
// under `/api/...` so the `/api` perimeter auth gate in server/index.ts
// covers them — same convention as client-checks.ts.

function describeUser(user: { firstName?: string | null; lastName?: string | null; email: string } | null): string {
  if (!user) return "un administrateur";
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name || user.email;
}

/**
 * Task #394 — append-only audit of project share link actions. Failure to
 * write the audit row is NOT swallowed for publish/unpublish (visibility
 * changes must be traceable), but the helper centralises actor resolution.
 */
async function recordShareAudit(opts: {
  projectId: number;
  action: "issue" | "rotate" | "extend" | "revoke" | "publish" | "unpublish";
  tokenId?: number | null;
  devisId?: number | null;
  actorUserId: number | null;
  detail: (actorLabel: string) => string;
}) {
  const user = (opts.actorUserId ? await storage.getUser(opts.actorUserId) : null) ?? null;
  await storage.createProjectShareAuditEntry({
    projectId: opts.projectId,
    action: opts.action,
    tokenId: opts.tokenId ?? null,
    devisId: opts.devisId ?? null,
    actorUserId: opts.actorUserId,
    detail: opts.detail(describeUser(user)),
  });
}

function tokenDto(t: {
  id: number;
  clientEmail: string;
  clientName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}) {
  // Deliberate whitelist — never the hash.
  return {
    id: t.id,
    clientEmail: t.clientEmail,
    clientName: t.clientName,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    expiresAt: t.expiresAt,
    revokedAt: t.revokedAt,
  };
}

/**
 * Current share-link state for the project: latest token (active or
 * revoked) plus the ids of the devis published on the ACTIVE token.
 */
router.get(
  "/api/projects/:projectId/client-share",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const latest = await storage.getLatestProjectShareToken(projectId);
    if (!latest) return res.json({ token: null, publishedDevisIds: [] });
    const active = latest.revokedAt ? null : latest;
    const publishedDevisIds = active ? await storage.listProjectShareDevisIds(active.id) : [];
    res.json({ token: tokenDto(latest), publishedDevisIds });
  },
);

/**
 * Issue (or rotate) the project share link. Always rotates because the raw
 * token can't be recovered from the hash; the storage layer carries the
 * publish memberships forward so rotation never silently unpublishes.
 */
router.post(
  "/api/projects/:projectId/client-share/issue",
  validateRequest({ params: projectIdParams, body: issueSchema }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const userId = req.session?.userId ?? null;
    const project = await storage.getProject(projectId);
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (!env.PUBLIC_BASE_URL) {
      return res.status(500).json({ message: "PUBLIC_BASE_URL is not configured" });
    }
    // Distinguish first issue from rotation BEFORE creating the new token.
    const hadToken = !!(await storage.getLatestProjectShareToken(projectId));
    const issued = await issueProjectShareToken({
      projectId,
      clientEmail: req.body.clientEmail,
      clientName: req.body.clientName ?? null,
      createdByUserId: userId ? Number(userId) : null,
    });
    const shareUrl = buildProjectShareUrl(env.PUBLIC_BASE_URL, issued.raw);
    const recipient = req.body.clientName
      ? `${req.body.clientName} <${req.body.clientEmail}>`
      : req.body.clientEmail;
    await recordShareAudit({
      projectId,
      action: hadToken ? "rotate" : "issue",
      tokenId: issued.record.id,
      actorUserId: userId ? Number(userId) : null,
      detail: (actor) =>
        hadToken
          ? `Lien projet régénéré pour ${recipient} par ${actor}.`
          : `Lien projet émis pour ${recipient} par ${actor}.`,
    });
    res.json({
      shareUrl,
      clientEmail: req.body.clientEmail,
      clientName: req.body.clientName ?? null,
    });
  },
);

/** Reset the sliding expiry window on the active link. */
router.post(
  "/api/projects/:projectId/client-share/extend",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const active = await storage.getActiveProjectShareToken(projectId);
    if (!active) return res.status(409).json({ message: "No active link to extend" });
    if (isTokenExpired(active)) {
      return res.status(409).json({ message: "Link expired — issue a new link instead." });
    }
    const newExpiry = computeTokenExpiry();
    const updated = await storage.extendProjectShareTokenExpiry(active.id, newExpiry);
    if (!updated) return res.status(409).json({ message: "Link was revoked in the meantime" });
    const expiryNote = newExpiry
      ? `expire le ${newExpiry.toLocaleString("fr-FR")}`
      : "sans date d'expiration";
    await recordShareAudit({
      projectId,
      action: "extend",
      tokenId: active.id,
      actorUserId: req.session?.userId ? Number(req.session.userId) : null,
      detail: (actor) => `Lien projet prolongé par ${actor} — ${expiryNote}.`,
    });
    res.json({ token: { id: updated.id, expiresAt: updated.expiresAt } });
  },
);

router.post(
  "/api/projects/:projectId/client-share/revoke",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const active = await storage.getActiveProjectShareToken(projectId);
    if (!active) return res.status(409).json({ message: "No active link to revoke" });
    const revoked = await storage.revokeProjectShareTokenById(active.id);
    if (!revoked) return res.status(409).json({ message: "Link already revoked" });
    await recordShareAudit({
      projectId,
      action: "revoke",
      tokenId: active.id,
      actorUserId: req.session?.userId ? Number(req.session.userId) : null,
      detail: (actor) => `Lien projet révoqué par ${actor}.`,
    });
    res.json({ ok: true });
  },
);

/**
 * Publish a devis onto the project share link. Gated: finalised English
 * translation required; void/provisional/superseded refused. Requires an
 * active link (membership is token-scoped).
 */
router.post(
  "/api/projects/:projectId/client-share/publish",
  validateRequest({ params: projectIdParams, body: devisRefSchema }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const userId = req.session?.userId ?? null;
    const active = await storage.getActiveProjectShareToken(projectId);
    if (!active || isTokenExpired(active)) {
      return res.status(409).json({ message: "Issue a client link for this project before publishing quotations." });
    }
    const devis = await storage.getDevis(req.body.devisId);
    if (!devis || devis.projectId !== projectId) {
      return res.status(404).json({ message: "Devis not found in this project" });
    }
    const blockReason = await getPublishBlockReason(devis);
    if (blockReason) return res.status(409).json({ message: blockReason });
    await storage.publishDevisToProjectShare({
      tokenId: active.id,
      devisId: devis.id,
      publishedByUserId: userId ? Number(userId) : undefined,
    });
    await recordShareAudit({
      projectId,
      action: "publish",
      tokenId: active.id,
      devisId: devis.id,
      actorUserId: userId ? Number(userId) : null,
      detail: (actor) => `Devis ${devis.devisCode} publié sur le lien projet par ${actor}.`,
    });
    res.json({ ok: true, devisId: devis.id });
  },
);

router.post(
  "/api/projects/:projectId/client-share/unpublish",
  validateRequest({ params: projectIdParams, body: devisRefSchema }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const active = await storage.getActiveProjectShareToken(projectId);
    if (!active) {
      return res.status(409).json({ message: "No active client link for this project." });
    }
    const removed = await storage.unpublishDevisFromProjectShare(active.id, req.body.devisId);
    if (!removed) return res.status(404).json({ message: "This devis is not published on the link." });
    const devis = await storage.getDevis(req.body.devisId);
    await recordShareAudit({
      projectId,
      action: "unpublish",
      tokenId: active.id,
      devisId: req.body.devisId,
      actorUserId: req.session?.userId ? Number(req.session.userId) : null,
      detail: (actor) =>
        `Devis ${devis?.devisCode ?? `#${req.body.devisId}`} retiré du lien projet par ${actor}.`,
    });
    res.json({ ok: true, devisId: req.body.devisId });
  },
);

/**
 * Task #394 — audit history of every action on the project share link
 * (issue / rotate / extend / revoke / publish / unpublish), newest first.
 */
router.get(
  "/api/projects/:projectId/client-share/audit",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const entries = await storage.listProjectShareAuditEntries(projectId);
    res.json({
      entries: entries.map((e) => ({
        id: e.id,
        action: e.action,
        devisId: e.devisId,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    });
  },
);

export default router;
