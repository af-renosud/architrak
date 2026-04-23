import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { issueDevisCheckToken, buildPortalUrl, computeTokenExpiry, isTokenExpired } from "../services/devis-checks";
import { queueDevisCheckBundle, sendCommunication } from "../communications/email-sender";
import { env } from "../env";
import { buildPortalPayload, renderPortalShell } from "./public-checks";
import { getDocumentStream } from "../storage/object-storage";

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
 * Global inbox of contractor responses awaiting the architect's attention,
 * across every project. Powers the sidebar Bell badge + dropdown. The
 * "unread" set is defined as every check currently in `awaiting_architect`
 * status — flipping the check out of that status (architect replies or
 * resolves) clears it from the inbox.
 */
router.get("/api/notifications/contractor-responses", async (_req, res) => {
  const [count, items] = await Promise.all([
    storage.countAwaitingArchitectInbox(),
    storage.listAwaitingArchitectInbox(50),
  ]);
  res.json({ count, items });
});

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

/**
 * Architect "preview as contractor" — read-only mirror of the contractor
 * portal HTML shell. Served from the architect-authed surface so it can be
 * iframed in the devis card without exposing a public URL. Crucially this
 * path NEVER issues a token, NEVER touches `lastUsedAt`, and NEVER mutates a
 * check status — guaranteeing the preview is side-effect-free.
 */
router.get(
  "/api/devis/:devisId/checks/portal-preview/shell",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).type("html").send("Devis introuvable");
    res.type("html").send(renderPortalShell({ mode: "preview", devisId }));
  },
);

/** JSON payload for the preview portal — same shape as /p/check/:token/data. */
router.get(
  "/api/devis/:devisId/checks/portal-preview/data",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis introuvable" });
    const payload = await buildPortalPayload(devis);
    if (!payload) return res.status(404).json({ message: "Devis introuvable" });
    res.json(payload);
  },
);

/** PDF stream for the preview portal — same content as /p/check/:token/pdf. */
router.get(
  "/api/devis/:devisId/checks/portal-preview/pdf",
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

    // Dedupe key = stable fingerprint over (sendable check ids + the latest
    // message revision across those checks). Properties:
    //   • Same ids + same maxMsgId ⇒ nothing has changed since the last
    //     dispatch ⇒ retry/double-click is idempotent (sent row short-
    //     circuits, queued/failed row is reused & retried with refreshed
    //     body). This is the explicit "no double-sends on retry" guarantee.
    //   • Architect (or contractor) writes a new message ⇒ maxMsgId bumps
    //     ⇒ fresh dedupe key ⇒ legitimate follow-up round ⇒ new audit row,
    //     new email — while still threading via Gmail (the prior round's
    //     thread/message id is reused via getLatestSentDevisCheckBundle).
    //   • Architect adds/removes a check ⇒ ids change ⇒ fresh key.
    const sortedIds = sendable.map((c) => c.id).sort((a, b) => a - b);
    const maxMsgId = await storage.getMaxMessageIdForChecks(sortedIds);
    const dedupeKey = `devis-check-bundle:${devisId}:m${maxMsgId}:${sortedIds.join(",")}`;

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

    // Pull full line items so the email/portal can show the devis line
    // position + HT amount alongside the description, not just the bundle
    // order. This is what lets the contractor cross-reference each question
    // against a specific line on their devis PDF (see Task #110).
    const lineItems = await storage.getDevisLineItems(devisId);
    const lineMap = new Map(lineItems.map((li) => [li.id, li]));
    const summaries = sendable.map((c) => {
      const li = c.lineItemId ? lineMap.get(c.lineItemId) ?? null : null;
      return {
        query: c.query,
        lineDescription: li?.description ?? null,
        lineNumber: li?.lineNumber ?? null,
        totalHt: li?.totalHt ?? null,
      };
    });

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

/**
 * Audit helper: write a "system" message in every existing check's thread on
 * this devis. We don't have a separate audit-log table — the devis-checks
 * feature already uses system-channel messages as its audit trail (see the
 * dispatch path in /checks/send), so we follow the same pattern here.
 */
async function auditTokenAction(devisId: number, note: string) {
  const checks = await storage.listDevisChecks(devisId);
  await Promise.all(
    checks.map((c) =>
      storage.createDevisCheckMessage({
        checkId: c.id,
        authorType: "system",
        body: note,
        channel: "system",
      }),
    ),
  );
  // Fallback when there is no check thread to host the audit row (e.g. the
  // architect rotates the link via "Copier le lien" before any question has
  // been written). Without this we'd silently drop the audit trail for that
  // edge case. Server logs aren't the strongest audit surface but they are
  // consistent with the rest of the request log and grep-able by devisId.
  if (checks.length === 0) {
    // eslint-disable-next-line no-console
    console.info(`[devis-check-token-audit] devis=${devisId} ${note}`);
  }
}

function describeUser(user: { firstName?: string | null; lastName?: string | null; email: string } | null): string {
  if (!user) return "un administrateur";
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name || user.email;
}

/**
 * Return current token state for the devis (latest active token, if any).
 * Powers the "Lien contractant" admin panel on the devis screen.
 */
router.get(
  "/api/devis/:devisId/check-token",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    // Use the latest token (active or revoked) so the panel can surface the
    // revocation timestamp after a Révoquer click — getActiveDevisCheckToken
    // would hide a just-revoked token and the UI would mis-render "Aucun lien".
    const t = await storage.getLatestDevisCheckToken(devisId);
    if (!t) return res.json({ token: null });
    res.json({
      token: {
        id: t.id,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
      },
    });
  },
);

/**
 * Architect "Prolonger" action: reset the sliding window on the active token
 * by recomputing expiresAt from now. No-op (409) when there is no active
 * token or when TTL is disabled (would be misleading).
 */
router.post(
  "/api/devis/:devisId/check-token/extend",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    const active = await storage.getActiveDevisCheckToken(devisId);
    if (!active) return res.status(409).json({ message: "Aucun lien actif à prolonger" });
    // Prolonger is for still-valid tokens only. An expired-but-not-revoked
    // token must be re-issued (rotated) via /checks/send instead, otherwise
    // we'd silently revive a link the contractor was already told had lapsed.
    if (isTokenExpired(active)) {
      return res.status(409).json({ message: "Lien expiré — émettre un nouveau lien via Envoyer" });
    }
    const newExpiry = computeTokenExpiry();
    const updated = await storage.extendDevisCheckTokenExpiry(active.id, newExpiry);
    if (!updated) return res.status(409).json({ message: "Lien révoqué entre-temps" });
    const user = (userId ? await storage.getUser(Number(userId)) : null) ?? null;
    const expiryNote = newExpiry
      ? `nouvelle expiration le ${newExpiry.toLocaleString("fr-FR")}`
      : "expiration désactivée";
    await auditTokenAction(
      devisId,
      `Lien contractant prolongé par ${describeUser(user)} — ${expiryNote}.`,
    );
    res.json({
      token: {
        id: updated.id,
        createdAt: updated.createdAt,
        lastUsedAt: updated.lastUsedAt,
        expiresAt: updated.expiresAt,
        revokedAt: updated.revokedAt,
      },
    });
  },
);

/**
 * Architect "Révoquer" action: revoke the currently active token. Idempotent
 * — repeated clicks after revocation simply return 409 with no audit churn.
 */
router.post(
  "/api/devis/:devisId/check-token/revoke",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    const active = await storage.getActiveDevisCheckToken(devisId);
    if (!active) return res.status(409).json({ message: "Aucun lien actif à révoquer" });
    const revoked = await storage.revokeDevisCheckTokenById(active.id);
    if (!revoked) return res.status(409).json({ message: "Lien déjà révoqué" });
    const user = (userId ? await storage.getUser(Number(userId)) : null) ?? null;
    await auditTokenAction(devisId, `Lien contractant révoqué par ${describeUser(user)}.`);
    res.json({ revoked: true });
  },
);

/**
 * Architect "Copier le lien" action: issue a fresh portal token and return the
 * raw URL so the architect can paste it into WhatsApp / SMS / etc. when the
 * email channel is not enough.
 *
 * IMPORTANT — this rotates the token. The hash-only storage means we cannot
 * recover the raw value of an existing active token, so the only way to hand
 * the architect a working URL is to issue a new one. The previous token (if
 * any) is automatically revoked by `storage.createDevisCheckToken`. This is
 * the same rotation behaviour `/checks/send` uses, and the frontend warns the
 * user before triggering it.
 *
 * Audited as a system message in every unresolved check thread so the action
 * is visible alongside the email-send audit trail.
 */
router.post(
  "/api/devis/:devisId/check-token/issue-for-copy",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const userId = req.session?.userId ?? null;
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis introuvable" });
    const contractor = await storage.getContractor(devis.contractorId);
    if (!contractor) return res.status(404).json({ message: "Entreprise introuvable" });
    if (!contractor.email) {
      return res.status(409).json({ message: "L'entreprise n'a pas d'email enregistré" });
    }
    if (!env.PUBLIC_BASE_URL) {
      return res.status(500).json({ message: "PUBLIC_BASE_URL is not configured" });
    }

    const issued = await issueDevisCheckToken({
      devisId,
      contractorId: contractor.id,
      contractorEmail: contractor.email,
      createdByUserId: userId,
    });
    const portalUrl = buildPortalUrl(env.PUBLIC_BASE_URL, issued.raw);

    const user = (userId ? await storage.getUser(Number(userId)) : null) ?? null;
    await auditTokenAction(
      devisId,
      `Lien contractant régénéré pour partage manuel par ${describeUser(user)}.`,
    );

    // Only return the URL — the TokenPanel re-fetches /check-token to refresh
    // its createdAt/expiresAt display, so we don't need to echo metadata that
    // would force the test mock to grow a `record` shape.
    res.json({ portalUrl });
  },
);

/** Revoke any active token for this devis (legacy path used during resend). */
router.post(
  "/api/devis/:devisId/checks/revoke-token",
  validateRequest({ params: devisIdParams }),
  async (req, res) => {
    await storage.revokeDevisCheckTokensForDevis(Number(req.params.devisId));
    res.json({ revoked: true });
  },
);

export default router;
