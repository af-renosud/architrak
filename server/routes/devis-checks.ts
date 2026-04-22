import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { issueDevisCheckToken, buildPortalUrl } from "../services/devis-checks";
import { queueDevisCheckBundle, sendCommunication } from "../communications/email-sender";
import { env } from "../env";

const router = Router();

const devisIdParams = z.object({ devisId: z.coerce.number().int().positive() });
const checkIdParams = z.object({ checkId: z.coerce.number().int().positive() });

const createCheckSchema = z.object({
  query: z.string().min(1).max(2000),
  lineItemId: z.number().int().positive().optional(),
}).strict();

const resolveCheckSchema = z.object({
  resolutionNote: z.string().max(2000).optional(),
}).strict();

const architectReplySchema = z.object({
  body: z.string().min(1).max(5000),
}).strict();

router.use(requireAuth);

/** List checks for a devis (with messages, for the architect side panel). */
router.get(
  "/api/devis/:devisId/checks",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const checks = await storage.listDevisChecks(devisId);
    const withMessages = await Promise.all(
      checks.map(async (c) => ({ ...c, messages: await storage.listDevisCheckMessages(c.id) })),
    );
    res.json(withMessages);
  },
);

/** Manually create a generic (non-line-item) check. */
router.post(
  "/api/devis/:devisId/checks",
  validateRequest({ params: devisIdParams, body: createCheckSchema }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    const created = await storage.createDevisCheck({
      devisId,
      origin: req.body.lineItemId ? "line_item" : "general",
      lineItemId: req.body.lineItemId ?? undefined,
      status: "open",
      query: req.body.query,
      createdByUserId: userId ?? undefined,
    });
    res.status(201).json(created);
  },
);

/** Architect resolves a check (only after contractor reply received). */
router.post(
  "/api/devis-checks/:checkId/resolve",
  validateRequest({ params: checkIdParams, body: resolveCheckSchema }),
  async (req, res) => {
    const checkId = Number(req.params.checkId);
    const userId = req.session?.userId ?? null;
    const updated = await storage.updateDevisCheck(checkId, {
      status: "resolved",
      resolutionNote: req.body.resolutionNote,
      resolvedAt: new Date(),
      resolvedByUserId: userId ?? undefined,
    });
    if (!updated) return res.status(404).json({ message: "Check not found" });
    res.json(updated);
  },
);

/** Architect drops/cancels an open check. */
router.post(
  "/api/devis-checks/:checkId/drop",
  validateRequest({ params: checkIdParams }),
  async (req, res) => {
    const checkId = Number(req.params.checkId);
    const userId = req.session?.userId ?? null;
    const updated = await storage.updateDevisCheck(checkId, {
      status: "dropped",
      resolvedAt: new Date(),
      resolvedByUserId: userId ?? undefined,
    });
    if (!updated) return res.status(404).json({ message: "Check not found" });
    res.json(updated);
  },
);

/** Architect post a follow-up message in the portal thread. */
router.post(
  "/api/devis-checks/:checkId/messages",
  validateRequest({ params: checkIdParams, body: architectReplySchema }),
  async (req, res) => {
    const checkId = Number(req.params.checkId);
    const userId = req.session?.userId ?? null;
    const check = await storage.getDevisCheck(checkId);
    if (!check) return res.status(404).json({ message: "Check not found" });
    const user = userId ? await storage.getUser(Number(userId)) : null;
    const msg = await storage.createDevisCheckMessage({
      checkId,
      authorType: "architect",
      authorUserId: user?.id ?? undefined,
      authorEmail: user?.email ?? undefined,
      authorName: user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email : undefined,
      body: req.body.body,
      channel: "portal",
    });
    // Architect reply → ball back in contractor's court.
    await storage.updateDevisCheck(checkId, { status: "awaiting_contractor" });
    res.status(201).json(msg);
  },
);

/**
 * Send the bundled "questions sur le devis" email. Generates / rotates the
 * portal token, queues one email, flips eligible open checks to
 * 'awaiting_contractor'. Idempotent: re-clicking does not duplicate the email
 * (dedupe_key keyed on devisId + open-check ids snapshot).
 */
router.post(
  "/api/devis/:devisId/checks/send",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    const contractor = await storage.getContractor(devis.contractorId);
    if (!contractor) return res.status(404).json({ message: "Contractor not found" });
    if (!contractor.email) {
      return res.status(409).json({ message: "Contractor has no email on file" });
    }

    const allChecks = await storage.listDevisChecks(devisId);
    const sendable = allChecks.filter((c) => c.status === "open" || c.status === "awaiting_architect");
    if (sendable.length === 0) {
      return res.status(409).json({ message: "No open checks to send" });
    }

    // Issue a fresh token (revokes any prior active token for this devis).
    const baseUrl = env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host") ?? "localhost"}`;
    const issued = await issueDevisCheckToken({
      devisId,
      contractorId: contractor.id,
      contractorEmail: contractor.email,
      createdByUserId: userId,
    });
    const portalUrl = buildPortalUrl(baseUrl, issued.raw);

    // Pull line descriptions for nicer email body.
    const lineItems = await storage.getDevisLineItems(devisId);
    const lineMap = new Map(lineItems.map((li) => [li.id, li.description]));
    const summaries = sendable.map((c) => ({
      query: c.query,
      lineDescription: c.lineItemId ? lineMap.get(c.lineItemId) ?? null : null,
    }));

    // Dedupe key incorporates the sorted set of sendable check ids — if the
    // architect adds a new check and re-sends, that's a different bundle.
    const dedupeKey = `devis-check-bundle:${devisId}:${sendable.map((c) => c.id).sort((a, b) => a - b).join(",")}`;

    const { communicationId, reused } = await queueDevisCheckBundle({
      devisId,
      portalUrl,
      dedupeKey,
      checkSummaries: summaries,
    });

    if (!reused) {
      try {
        await sendCommunication(communicationId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Email send failed";
        return res.status(502).json({ message: msg });
      }
    }

    // Flip eligible checks to awaiting_contractor.
    for (const c of sendable) {
      await storage.updateDevisCheck(c.id, { status: "awaiting_contractor" });
    }

    res.json({
      communicationId,
      reused,
      checksSent: sendable.length,
      // Raw token only returned once (architect copy/audit only).
      portalUrl,
    });
  },
);

/** Revoke any active token for this devis. */
router.post(
  "/api/devis/:devisId/checks/revoke-token",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    await storage.revokeDevisCheckTokensForDevis(Number(req.params.devisId));
    res.json({ revoked: true });
  },
);

export default router;
