import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { getGmailMonitorStatus, pollInbox } from "../gmail/monitor";
import { processEmailDocument } from "../gmail/document-parser";
import { insertEmailDocumentSchema, type InsertEmailDocument } from "@shared/schema";
import { classifyGmailPollHealth, type GmailPollHealth } from "@shared/gmail-poll-health";
import { validateRequest } from "../middleware/validate";
import { dismissEmailDocument, purgeSkippedEmailDocument, DismissRefusedError } from "../services/email-document-dismiss.service";
import { EMAIL_PURGE_DAYS_KEY, EMAIL_PURGE_DAYS_DEFAULT } from "../services/email-document-processor.service";

/** Task #506 — messages failing this many consecutive polls are surfaced in the dashboard. */
export const PERSISTENT_FAILURE_THRESHOLD = 5;

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
// Task #322 — extractionStatus is server-authoritative (state machine:
// claim/retry/terminal transitions only). Exposing it on the generic PATCH
// would let a caller revive a dumped ('skipped') document back to 'pending'
// and defeat the beta reset. Omit from the schema AND delete from the body
// (devis state-machine seal pattern).
const updateEmailDocSchema = insertEmailDocumentSchema.partial().omit({ extractionStatus: true });
const emailDocsQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  status: z.string().optional(),
  documentType: z.string().optional(),
});

router.get("/api/gmail/status", async (_req, res) => {
  // Poll-health is classified from the PERSISTED per-user poll columns
  // (users.gmail_last_poll_*), NOT the monitor's in-memory state — the
  // in-memory state resets to "idle / Never" on every restart, which is
  // exactly how a dead poller went unnoticed for two months in production.
  let pollHealth: GmailPollHealth;
  try {
    const users = await storage.listGmailPollingUsers();
    if (users.length === 0) {
      pollHealth = classifyGmailPollHealth({
        linked: false,
        lastPollAt: null,
        lastPollStatus: null,
        now: new Date(),
      });
    } else {
      // If ANY linked account lost its Google authorization, surface that
      // first — it needs a human to re-link. Otherwise judge staleness by
      // the freshest account: if even the freshest is stale, the scanning
      // loop itself is down.
      const revoked = users.find((u) => u.gmailLastPollStatus === "auth_revoked");
      const freshest = users.reduce((a, b) =>
        (b.gmailLastPollAt?.getTime() ?? 0) > (a.gmailLastPollAt?.getTime() ?? 0) ? b : a,
      );
      const subject = revoked ?? freshest;
      pollHealth = classifyGmailPollHealth({
        linked: true,
        lastPollAt: subject.gmailLastPollAt,
        lastPollStatus: subject.gmailLastPollStatus,
        now: new Date(),
      });
    }
  } catch (err) {
    console.error("[Gmail] poll-health classification failed:", err);
    pollHealth = { level: "never", ageMs: null, message: "Could not determine inbox scan health." };
  }
  // Task #313: surface how many emailed documents finished extraction but
  // could not be matched to a project (needs_review + projectId null) so the
  // dashboard can flag them instead of leaving them buried in the queue page.
  let needsProjectCount = 0;
  try {
    const needsReview = await storage.getEmailDocuments({ status: "needs_review" });
    needsProjectCount = needsReview.filter((d) => d.projectId == null).length;
  } catch (err) {
    console.error("[Gmail] needs-project count failed:", err);
  }

  // Task #506 — count messages that have failed >= PERSISTENT_FAILURE_THRESHOLD
  // consecutive polls so the banner can alert the architect.
  let persistentFailureCount = 0;
  try {
    persistentFailureCount = await storage.getPersistentGmailFailureCount(PERSISTENT_FAILURE_THRESHOLD);
  } catch (err) {
    console.error("[Gmail] persistent-failure count failed:", err);
  }

  res.json({ ...getGmailMonitorStatus(), pollHealth, needsProjectCount, persistentFailureCount });
});

// Task #506 — list messages stuck in repeated poll failures.
router.get("/api/gmail/stuck-messages", async (_req, res) => {
  try {
    const rows = await storage.getPersistentGmailFailures(PERSISTENT_FAILURE_THRESHOLD);
    res.json(rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Failed to load stuck messages: ${message}` });
  }
});

// Task #506 — skip a specific (userId, messageId) pair so the poll never retries it.
// Scoped to the exact user whose inbox produced the failure; never bulk-skips other users.
// Audit-noted via skip_reason; the original email is never deleted from Gmail.
router.post(
  "/api/gmail/stuck-messages/:messageId/skip",
  validateRequest({
    params: z.object({ messageId: z.string().min(1) }),
    body: z.object({ userId: z.number().int().positive(), reason: z.string().optional() }),
  }),
  async (req, res) => {
    const { messageId } = req.params as { messageId: string };
    const { userId, reason } = req.body as { userId: number; reason?: string };
    const skipReason = reason ?? "Manually skipped by operator";
    try {
      await storage.skipGmailMessage(userId, messageId, skipReason);
      res.json({ skipped: true, messageId, userId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Skip failed: ${message}` });
    }
  },
);

router.post("/api/gmail/poll", validateRequest({ body: z.object({}).strict().optional() }), async (_req, res) => {
  try {
    const result = await pollInbox();
    res.json(result);
  } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

    const stats = await storage.getEmailQueueStats();
    res.status(500).json({ message: `Queue stats failed: ${message}` });
  }
});

router.get(
  "/api/email-documents",
  validateRequest({ query: emailDocsQuerySchema }),
  async (req, res) => {
    const q = req.query as unknown as z.infer<typeof emailDocsQuerySchema>;
    const docs = await storage.getEmailDocuments({
      projectId: q.projectId,
      status: q.status,
      documentType: q.documentType,
    });
    res.json(docs);
  },
);

// Task #550 — retention window (days) after which skipped documents are
// permanently purged by the background sweeper. 0 disables auto-purge.
// NB: registered BEFORE `/:id` so "settings" is never parsed as an id.
router.get("/api/email-documents/settings/purge", async (_req, res) => {
  const raw = await storage.getAppSetting(EMAIL_PURGE_DAYS_KEY);
  const days = raw != null && Number.isFinite(Number(raw)) ? Number(raw) : EMAIL_PURGE_DAYS_DEFAULT;
  res.json({ purgeDays: days });
});
const purgeSettingsSchema = z.object({ purgeDays: z.number().int().min(0).max(3650) });
router.put(
  "/api/email-documents/settings/purge",
  validateRequest({ body: purgeSettingsSchema }),
  async (req, res) => {
    const { purgeDays } = req.body as z.infer<typeof purgeSettingsSchema>;
    await storage.setAppSetting(EMAIL_PURGE_DAYS_KEY, String(purgeDays));
    res.json({ purgeDays });
  },
);

router.get("/api/email-documents/:id", validateRequest({ params: idParams }), async (req, res) => {
  // (was mistakenly calling update with the request body — read-only now)
  const doc = await storage.getEmailDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ message: "Document not found" });
  res.json(doc);
});

// Task #550 — bulk "not relevant" dismissal in ONE call. Reuses the atomic
// per-document dismissal (promoted docs refused, storage-key safety),
// returning per-id results so the UI can report refusals.
const bulkDismissSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
});
router.post(
  "/api/email-documents/bulk-dismiss",
  validateRequest({ body: bulkDismissSchema }),
  async (req, res) => {
    const { ids } = req.body as z.infer<typeof bulkDismissSchema>;
    const uniqueIds = Array.from(new Set(ids));
    const results: Array<{ id: number; outcome: string; message?: string }> = [];
    for (const id of uniqueIds) {
      try {
        const result = await dismissEmailDocument(id);
        if (result.outcome === "already_dismissed") {
          // Already skipped ("removed") — the operator is emptying the
          // Skipped view: permanently purge it now.
          const purged = await purgeSkippedEmailDocument(id);
          results.push({ id, outcome: purged ? "purged" : "refused", message: purged ? undefined : "Could not purge — linked to a record or busy." });
        } else {
          results.push({ id, outcome: result.outcome });
        }
      } catch (err) {
        if (err instanceof DismissRefusedError) {
          results.push({ id, outcome: "refused", message: err.message });
        } else {
          results.push({ id, outcome: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    const removed = results.filter(r => r.outcome === "dismissed" || r.outcome === "already_dismissed" || r.outcome === "purged").length;
    const refused = results.filter(r => r.outcome === "refused" || r.outcome === "error").length;
    res.json({ removed, refused, results });
  },
);

router.patch(
  "/api/email-documents/:id",
  validateRequest({ params: idParams, body: updateEmailDocSchema }),
  async (req, res) => {
    // Belt-and-braces: never let status transitions ride the generic PATCH.
    delete (req.body as Record<string, unknown>).extractionStatus;
    const doc = await storage.updateEmailDocument(Number(req.params.id), req.body);
    if (!doc) return res.status(404).json({ message: "Document not found" });
    res.json(doc);
  },
);

// Task #421 — "not relevant" dismissal. Soft-disposition (skipped +
// tombstone + mirror/storage cleanup) handled by the service; promoted
// documents are refused with 409.
router.delete(
  "/api/email-documents/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const result = await dismissEmailDocument(Number(req.params.id));
      if (result.outcome === "not_found") {
        return res.status(404).json({ message: "Document not found" });
      }
      res.json({ id: result.id, dismissed: true, alreadyDismissed: result.outcome === "already_dismissed" });
    } catch (err: unknown) {
      if (err instanceof DismissRefusedError) {
        return res.status(409).json({ message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Dismiss failed: ${message}` });
    }
  },
);

router.post(
  "/api/email-documents/:id/process",
  validateRequest({ params: idParams, body: z.object({ force: z.boolean().optional() }).optional() }),
  async (req, res) => {
    try {
      // Task #323 — `force: true` bypasses the deterministic sender
      // pre-filter so an operator can rescue a doc parked as
      // 'unmatched_sender' and run the AI extraction anyway.
      await processEmailDocument(Number(req.params.id), {
        bypassPrefilter: (req.body as { force?: boolean } | undefined)?.force === true,
      });
      const updated = await storage.getEmailDocument(Number(req.params.id));
      res.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

    const stats = await storage.getEmailQueueStats();
      res.status(500).json({ message: `Processing failed: ${message}` });
    }
  },
);

export default router;
