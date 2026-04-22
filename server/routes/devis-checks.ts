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
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });

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

/**
 * Bulk open-checks counts for every devis in a project. Powers the CHECKING
 * badge shown on collapsed devis rows in the project view.
 */
router.get(
  "/api/projects/:projectId/devis-checks/open-counts",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const counts = await storage.countOpenDevisChecksForProject(projectId);
    res.json(counts);
  },
);

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
    // Sendable: every unresolved check participates in the bundle, regardless
    // of whether the ball is currently in the contractor's or the architect's
    // court. This is what enables follow-up rounds: after the contractor
    // replies and the architect writes a follow-up message (which flips the
    // check to awaiting_contractor), clicking Envoyer must include that check
    // in the next outbound email.
    const sendable = allChecks.filter(
      (c) => c.status === "open" || c.status === "awaiting_architect" || c.status === "awaiting_contractor",
    );
    if (sendable.length === 0) {
      return res.status(409).json({ message: "No open checks to send" });
    }

    // Canonical origin only — never derive portal URL from request Host header
    // (host-header poisoning would let attackers exfiltrate the portal token
    // through emails sent from a poisoned hostname).
    if (!env.PUBLIC_BASE_URL) {
      return res.status(500).json({ message: "PUBLIC_BASE_URL is not configured" });
    }
    const baseUrl = env.PUBLIC_BASE_URL;

    // Dedupe key incorporates BOTH a per-dispatch "round" marker (count of
    // bundles that have already been successfully sent for this devis) AND
    // the sorted set of sendable check ids. Why both?
    //   • Same round + same ids → the user double-clicked Envoyer or is
    //     retrying a failed attempt → we want idempotent reuse of the row.
    //   • Next round (round increments only on a successful prior send) →
    //     legitimate follow-up dispatch → we MUST send a fresh email and
    //     create a new audit row, while still threading via Gmail
    //     (getLatestSentDevisCheckBundle).
    //   • Different ids (architect added a new question) → fresh bundle.
    const round = await storage.countSentDevisCheckBundles(devisId);
    const sortedIds = sendable.map((c) => c.id).sort((a, b) => a - b).join(",");
    const dedupeKey = `devis-check-bundle:${devisId}:r${round}:${sortedIds}`;

    // Probe whether this exact bundle was already SUCCESSFULLY sent. If so,
    // do not rotate the token and do not resend. If a prior attempt is queued
    // or failed, we'll fall through and retry on the same row — but with a
    // freshly issued token AND a body rewritten with the new portal URL,
    // since rotation would otherwise invalidate the URL embedded in the
    // existing email body.
    const priorSameBundle = await storage.getProjectCommunicationByDedupeKey(dedupeKey);
    if (priorSameBundle && priorSameBundle.status === "sent") {
      return res.json({
        communicationId: priorSameBundle.id,
        reused: true,
        checksSent: sendable.length,
      });
    }

    // Issue / rotate a token for the (re-)send. Whether or not an active
    // token exists we still rotate, because the old raw value is not
    // recoverable (hash-only storage) and the new email must contain a
    // working link.
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

    const { communicationId, alreadySent: queueAlreadySent, refreshedBody, refreshedSubject } =
      await queueDevisCheckBundle({
        devisId,
        portalUrl,
        dedupeKey,
        checkSummaries: summaries,
      });

    if (queueAlreadySent) {
      return res.json({ communicationId, reused: true, checksSent: sendable.length });
    }

    // Retry path: existing comm row was reused. Rewrite its body (and subject
    // — defensive, in case a downstream change ever varies it) with the
    // freshly generated portal URL so the resent email carries a valid link
    // for the rotated token.
    if (priorSameBundle && priorSameBundle.status !== "sent") {
      await storage.updateProjectCommunication(communicationId, {
        body: refreshedBody,
        subject: refreshedSubject,
      });
    }

    // Look up the most recent prior bundle for this devis so the follow-up
    // email threads with the contractor's existing conversation in Gmail.
    const priorThread = await storage.getLatestSentDevisCheckBundle(devisId);
    try {
      await sendCommunication(communicationId, {
        threadId: priorThread?.emailThreadId ?? null,
        inReplyToMessageId: priorThread?.emailMessageId ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Email send failed";
      return res.status(502).json({ message: msg });
    }

    // Audit: write a system message in each check's thread recording dispatch.
    const sentAt = new Date();
    const dispatchNote = `Question envoyée à ${contractor.email} le ${sentAt.toLocaleString("fr-FR")}.`;
    await Promise.all(
      sendable.map((c) =>
        storage.createDevisCheckMessage({
          checkId: c.id,
          authorType: "system",
          body: dispatchNote,
          channel: "email",
        }),
      ),
    );

    // Flip eligible checks to awaiting_contractor.
    for (const c of sendable) {
      await storage.updateDevisCheck(c.id, { status: "awaiting_contractor" });
    }

    res.json({
      communicationId,
      reused: false,
      checksSent: sendable.length,
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
