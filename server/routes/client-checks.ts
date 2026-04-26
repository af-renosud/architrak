import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import {
  issueClientCheckToken,
  buildClientPortalUrl,
  computeTokenExpiry,
  isTokenExpired,
} from "../services/client-checks";
import { env } from "../env";
import { buildClientPortalPayload, renderClientPortalShell } from "./public-client-checks";
import { getDocumentStream } from "../storage/object-storage";

const router = Router();

const devisIdParams = z.object({ devisId: z.coerce.number().int().positive() });
const checkIdParams = z.object({ checkId: z.coerce.number().int().positive() });

const sendToClientSchema = z.object({
  clientEmail: z.string().email(),
  clientName: z.string().max(200).optional(),
}).strict();

const architectReplySchema = z.object({
  body: z.string().min(1).max(5000),
}).strict();

const resolveSchema = z.object({
  resolutionNote: z.string().max(2000).optional(),
}).strict();

// NOTE: this router is mounted at the application root in routes/index.ts;
// every route here is under `/api/...` so the `/api` perimeter auth gate in
// server/index.ts already covers them. No router-level requireAuth — see the
// production crash note in devis-checks.ts (2026-04-24).

/**
 * List all client_checks for a devis with their message threads. Powers the
 * architect-side review panel and the "Send to client" CTA wiring.
 */
router.get(
  "/api/devis/:devisId/client-checks",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const checks = await storage.listClientChecks(devisId);
    const withMessages = await Promise.all(
      checks.map(async (c) => ({ ...c, messages: await storage.listClientCheckMessages(c.id) })),
    );
    res.json(withMessages);
  },
);

/**
 * Architect "preview as client" — read-only mirror of the client portal HTML
 * shell. Side-effect-free: no token issuance, no lastUsedAt touch, no status
 * mutation. Mirrors the contractor-portal preview pattern.
 */
router.get(
  "/api/devis/:devisId/client-checks/portal-preview/shell",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).type("html").send("Devis introuvable");
    res.type("html").send(renderClientPortalShell({ mode: "preview", devisId }));
  },
);

router.get(
  "/api/devis/:devisId/client-checks/portal-preview/data",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis introuvable" });
    const payload = await buildClientPortalPayload(devis, null);
    if (!payload) return res.status(404).json({ message: "Devis introuvable" });
    res.json(payload);
  },
);

router.get(
  "/api/devis/:devisId/client-checks/portal-preview/pdf",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const devis = await storage.getDevis(devisId);
    if (!devis?.pdfStorageKey) return res.status(404).json({ message: "PDF indisponible" });
    try {
      const doc = await getDocumentStream(devis.pdfStorageKey);
      res.setHeader("Content-Type", doc.contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="devis-${devis.devisCode}.pdf"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      doc.stream.pipe(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur lecture PDF";
      res.status(500).json({ message: msg });
    }
  },
);

/**
 * Architect posts a follow-up message in the portal thread. Mirror of the
 * devis-check architect reply, scoped to client_check_messages. Does NOT
 * change the check status — closing the loop on a client question is the
 * architect's explicit `resolve` action (clients shouldn't have a thread
 * silently flipped under them just because the architect typed something).
 */
router.post(
  "/api/client-checks/:checkId/messages",
  validateRequest({ params: checkIdParams, body: architectReplySchema }),
  async (req, res) => {
    const checkId = Number(req.params.checkId);
    const userId = req.session?.userId ?? null;
    const check = await storage.getClientCheck(checkId);
    if (!check) return res.status(404).json({ message: "Check not found" });
    const user = userId ? await storage.getUser(Number(userId)) : null;
    const msg = await storage.createClientCheckMessage({
      checkId,
      authorType: "architect",
      authorUserId: user?.id ?? undefined,
      authorEmail: user?.email ?? undefined,
      authorName: user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email : undefined,
      body: req.body.body,
      channel: "portal",
    });
    // Bump updatedAt so the architect inbox surfaces movement.
    await storage.updateClientCheck(checkId, {});
    res.status(201).json(msg);
  },
);

/** Architect resolves a client check (closes the thread). */
router.post(
  "/api/client-checks/:checkId/resolve",
  validateRequest({ params: checkIdParams, body: resolveSchema }),
  async (req, res) => {
    const checkId = Number(req.params.checkId);
    const userId = req.session?.userId ?? null;
    const user = userId ? await storage.getUser(Number(userId)) : null;
    const updated = await storage.updateClientCheck(checkId, {
      status: "resolved",
      resolvedAt: new Date(),
      resolvedBySource: "architrak_internal",
      resolvedByActor: "architect",
      resolvedByUserEmail: user?.email ?? null,
      resolutionNote: req.body.resolutionNote,
    });
    if (!updated) return res.status(404).json({ message: "Check not found" });
    res.json(updated);
  },
);

/** Architect cancels a client check (e.g. raised by mistake). */
router.post(
  "/api/client-checks/:checkId/cancel",
  validateRequest({ params: checkIdParams }),
  async (req, res) => {
    const checkId = Number(req.params.checkId);
    const updated = await storage.updateClientCheck(checkId, {
      status: "cancelled",
      resolvedAt: new Date(),
    });
    if (!updated) return res.status(404).json({ message: "Check not found" });
    res.json(updated);
  },
);

/**
 * Audit helper — mirrors `auditTokenAction` in devis-checks.ts. Writes a
 * system-channel message in every existing client_check thread on the devis.
 * Falls back to a server log line when there are no threads yet so the audit
 * trail isn't silently dropped at the empty-state edge.
 */
async function auditClientTokenAction(devisId: number, note: string) {
  const checks = await storage.listClientChecks(devisId);
  await Promise.all(
    checks.map((c) =>
      storage.createClientCheckMessage({
        checkId: c.id,
        authorType: "system",
        body: note,
        channel: "system",
      }),
    ),
  );
  if (checks.length === 0) {
    // eslint-disable-next-line no-console
    console.info(`[client-check-token-audit] devis=${devisId} ${note}`);
  }
}

function describeUser(user: { firstName?: string | null; lastName?: string | null; email: string } | null): string {
  if (!user) return "un administrateur";
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name || user.email;
}

/** Current token state for the devis (latest token, active or revoked). */
router.get(
  "/api/devis/:devisId/client-check-token",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const t = await storage.getLatestClientCheckToken(devisId);
    if (!t) return res.json({ token: null });
    res.json({
      token: {
        id: t.id,
        clientEmail: t.clientEmail,
        clientName: t.clientName,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
      },
    });
  },
);

/**
 * "Send to client" — issues (or rotates) the client portal token and returns
 * the share URL so the architect can copy it into their preferred channel
 * (email / WhatsApp / SMS). v1 intentionally does NOT auto-send an email —
 * AT5 (outbound webhook) is out of scope for this task.
 *
 * Always rotates the token because raw values aren't recoverable from the
 * hash. The frontend gates this behind a confirm dialog.
 */
router.post(
  "/api/devis/:devisId/client-check-token/issue",
  validateRequest({ params: devisIdParams, body: sendToClientSchema }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis introuvable" });
    if (!env.PUBLIC_BASE_URL) {
      return res.status(500).json({ message: "PUBLIC_BASE_URL is not configured" });
    }
    const issued = await issueClientCheckToken({
      devisId,
      clientEmail: req.body.clientEmail,
      clientName: req.body.clientName ?? null,
      createdByUserId: userId,
    });
    const portalUrl = buildClientPortalUrl(env.PUBLIC_BASE_URL, issued.raw);
    const user = (userId ? await storage.getUser(Number(userId)) : null) ?? null;
    const recipient = req.body.clientName
      ? `${req.body.clientName} <${req.body.clientEmail}>`
      : req.body.clientEmail;
    await auditClientTokenAction(
      devisId,
      `Lien client émis pour ${recipient} par ${describeUser(user)}.`,
    );
    res.json({ portalUrl, clientEmail: req.body.clientEmail, clientName: req.body.clientName ?? null });
  },
);

/** Architect "Prolonger" — reset the sliding window on the active token. */
router.post(
  "/api/devis/:devisId/client-check-token/extend",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    const active = await storage.getActiveClientCheckToken(devisId);
    if (!active) return res.status(409).json({ message: "Aucun lien actif à prolonger" });
    if (isTokenExpired(active)) {
      return res.status(409).json({
        message: "Lien expiré — émettre un nouveau lien via Envoyer au client.",
      });
    }
    const newExpiry = computeTokenExpiry();
    const updated = await storage.extendClientCheckTokenExpiry(active.id, newExpiry);
    if (!updated) return res.status(409).json({ message: "Lien révoqué entre-temps" });
    const user = (userId ? await storage.getUser(Number(userId)) : null) ?? null;
    const expiryNote = newExpiry
      ? `expire le ${newExpiry.toLocaleString("fr-FR")}`
      : "sans date d'expiration";
    await auditClientTokenAction(
      devisId,
      `Lien client prolongé par ${describeUser(user)} — ${expiryNote}.`,
    );
    res.json({ token: { id: updated.id, expiresAt: updated.expiresAt } });
  },
);

router.post(
  "/api/devis/:devisId/client-check-token/revoke",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    const active = await storage.getActiveClientCheckToken(devisId);
    if (!active) return res.status(409).json({ message: "Aucun lien actif à révoquer" });
    const revoked = await storage.revokeClientCheckTokenById(active.id);
    if (!revoked) return res.status(409).json({ message: "Lien déjà révoqué" });
    const user = (userId ? await storage.getUser(Number(userId)) : null) ?? null;
    await auditClientTokenAction(devisId, `Lien client révoqué par ${describeUser(user)}.`);
    res.json({ ok: true });
  },
);

export default router;
