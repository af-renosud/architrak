import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import {
  issueClientCheckTokenEmail,
  clientLinkDeliveryDedupeKey,
  computeTokenExpiry,
  isTokenExpired,
} from "../services/client-checks";
import { env } from "../env";
import { buildClientPortalPayload, renderClientPortalShell, streamCombinedPackagePdf } from "./public-client-checks";
import { getDocumentStream } from "../storage/object-storage";
import { isValidRecipientEmail, sendCommunication, CommunicationSendInProgressError } from "../communications/email-sender";

const router = Router();

const devisIdParams = z.object({ devisId: z.coerce.number().int().positive() });
const checkIdParams = z.object({ checkId: z.coerce.number().int().positive() });

const sendToClientSchema = z.object({
  clientEmail: z.string().email(),
  clientName: z.string().trim().max(200).optional(),
  message: z.string().trim().min(10).max(2000),
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
    if (!devis) return res.status(404).type("html").send("Devis not found");
    // Optional back-link to the project-level architect preview (Task #403
    // follow-up): the project preview page passes ?projectId= so the
    // click-through keeps an obvious "view all" route back.
    const rawProjectId = req.query.projectId;
    const projectId = typeof rawProjectId === "string" && /^\d+$/.test(rawProjectId)
      ? Number(rawProjectId)
      : null;
    const backUrl = projectId !== null && devis.projectId === projectId
      ? `/api/projects/${projectId}/client-share/preview/shell`
      : null;
    res.type("html").send(renderClientPortalShell({ mode: "preview", devisId, backUrl }));
  },
);

router.get(
  "/api/devis/:devisId/client-checks/portal-preview/data",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    const payload = await buildClientPortalPayload(devis, null);
    if (!payload) return res.status(404).json({ message: "Devis not found" });
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
 * Architect preview of the client "complete package" download (Task #389).
 * Same gating as the live endpoint — finalised translation + original PDF.
 */
router.get(
  "/api/devis/:devisId/client-checks/portal-preview/package.pdf",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    await streamCombinedPackagePdf(devis, res);
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

function serializeClientToken(t: Awaited<ReturnType<typeof storage.getLatestClientCheckToken>>) {
  if (!t) return null;
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

function serializeClientLinkDelivery(
  delivery: Awaited<ReturnType<typeof storage.getProjectCommunication>>,
) {
  if (!delivery) return null;
  const portalUrl = delivery.type === "devis_client_link"
    ? delivery.body?.match(/https?:\/\/[^\s]+\/p\/client\/[A-Za-z0-9_-]+/)?.[0] ?? null
    : null;
  return {
    communicationId: delivery.id,
    status: delivery.status,
    sentAt: delivery.sentAt,
    recipientEmail: delivery.recipientEmail,
    recipientName: delivery.recipientName,
    portalUrl,
  };
}

/** Current token state for the devis (latest token, active or revoked). */
router.get(
  "/api/devis/:devisId/client-check-token",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const t = await storage.getLatestClientCheckToken(devisId);
    if (!t) return res.json({ token: null });
    const delivery = await storage.getProjectCommunicationByDedupeKey(clientLinkDeliveryDedupeKey(t.id));
    res.json({
      token: serializeClientToken(t),
      delivery: serializeClientLinkDelivery(delivery),
    });
  },
);

/**
 * Issues a fresh client portal token, durably queues its email, then dispatches
 * through the initiating architect's Gmail connection. The token and queued
 * communication are created in one transaction.
 */
router.post(
  "/api/devis/:devisId/client-check-token/issue",
  validateRequest({ params: devisIdParams, body: sendToClientSchema }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    const project = await storage.getProject(devis.projectId);
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (project.archivedAt) return res.status(409).json({ message: "Archived projects are read-only" });
    if (devis.status === "void" || devis.accountingState === "superseded") {
      return res.status(409).json({ message: "This devis cannot be shared with the client" });
    }
    if (!isValidRecipientEmail(req.body.clientEmail)) {
      return res.status(400).json({ message: "Invalid client email address" });
    }
    if (!env.PUBLIC_BASE_URL) {
      return res.status(500).json({ message: "PUBLIC_BASE_URL is not configured" });
    }
    const clientName = req.body.clientName || null;
    const issued = await issueClientCheckTokenEmail({
      devisId,
      projectId: devis.projectId,
      projectName: project.name,
      devisRef: devis.devisNumber || devis.devisCode,
      clientEmail: req.body.clientEmail,
      clientName,
      message: req.body.message,
      createdByUserId: userId,
      baseUrl: env.PUBLIC_BASE_URL,
    });
    const user = (userId ? await storage.getUser(Number(userId)) : null) ?? null;
    const recipient = clientName
      ? `${clientName} <${req.body.clientEmail}>`
      : req.body.clientEmail;
    if (issued.reused) {
      return res.status(409).json({
        message: issued.communication.status === "failed"
          ? "A failed delivery already exists for this active link. Use Retry to send the same link and message safely."
          : "This client link email is already being sent",
      });
    }
    try {
      await sendCommunication(issued.communication.id, { sentByUserId: userId });
    } catch (error) {
      if (error instanceof CommunicationSendInProgressError) {
        return res.status(409).json({ message: "This client link email is already being sent" });
      }
      await auditClientTokenAction(devisId, `Échec de l’envoi du lien client à ${recipient} par ${describeUser(user)}.`);
      const failed = await storage.getProjectCommunication(issued.communication.id);
      return res.status(502).json({
        message: error instanceof Error ? error.message : "Client link email failed",
        token: serializeClientToken(issued.record),
        delivery: serializeClientLinkDelivery(failed),
      });
    }
    await auditClientTokenAction(devisId, `Lien client envoyé à ${recipient} par ${describeUser(user)}.`);
    const sent = await storage.getProjectCommunication(issued.communication.id);
    res.json({
      token: serializeClientToken(issued.record),
      delivery: serializeClientLinkDelivery(sent),
    });
  },
);

router.post(
  "/api/devis/:devisId/client-check-token/resend",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    const project = await storage.getProject(devis.projectId);
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (project.archivedAt) return res.status(409).json({ message: "Archived projects are read-only" });
    if (devis.status === "void" || devis.accountingState === "superseded") {
      return res.status(409).json({ message: "This devis cannot be shared with the client" });
    }
    const token = await storage.getActiveClientCheckToken(devisId);
    if (!token) return res.status(404).json({ message: "No active client link found" });
    if (isTokenExpired(token)) return res.status(409).json({ message: "The client link has expired; issue a new link instead" });
    const communication = await storage.getProjectCommunicationByDedupeKey(clientLinkDeliveryDedupeKey(token.id));
    if (!communication) return res.status(404).json({ message: "No client link email found" });
    if (communication.status === "sent") {
      return res.json({
        token: serializeClientToken(token),
        delivery: serializeClientLinkDelivery(communication),
      });
    }
    try {
      await sendCommunication(communication.id, { sentByUserId: userId });
    } catch (error) {
      if (error instanceof CommunicationSendInProgressError) {
        return res.status(409).json({ message: "This client link email is already being sent" });
      }
      const failed = await storage.getProjectCommunication(communication.id);
      return res.status(502).json({
        message: error instanceof Error ? error.message : "Client link email failed",
        token: serializeClientToken(token),
        delivery: serializeClientLinkDelivery(failed),
      });
    }
    const sent = await storage.getProjectCommunication(communication.id);
    await auditClientTokenAction(devisId, `Envoi du lien client relancé avec succès vers ${communication.recipientEmail}.`);
    res.json({
      token: serializeClientToken(token),
      delivery: serializeClientLinkDelivery(sent),
    });
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
    if (!active) return res.status(409).json({ message: "No active link to extend" });
    if (isTokenExpired(active)) {
      return res.status(409).json({
        message: "Link expired — issue a new link via Send to Client.",
      });
    }
    const newExpiry = computeTokenExpiry();
    const updated = await storage.extendClientCheckTokenExpiry(active.id, newExpiry);
    if (!updated) return res.status(409).json({ message: "Link was revoked in the meantime" });
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
    if (!active) return res.status(409).json({ message: "No active link to revoke" });
    const revoked = await storage.revokeClientCheckTokenById(active.id);
    if (!revoked) return res.status(409).json({ message: "Link already revoked" });
    const user = (userId ? await storage.getUser(Number(userId)) : null) ?? null;
    await auditClientTokenAction(devisId, `Lien client révoqué par ${describeUser(user)}.`);
    res.json({ ok: true });
  },
);

export default router;
