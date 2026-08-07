import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { getGmailMonitorStatus, pollInbox } from "../gmail/monitor";
import { processEmailDocument } from "../gmail/document-parser";
import { insertEmailDocumentSchema, type InsertEmailDocument } from "@shared/schema";
import { classifyGmailPollHealth, type GmailPollHealth } from "@shared/gmail-poll-health";
import { validateRequest } from "../middleware/validate";

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

  res.json({ ...getGmailMonitorStatus(), pollHealth, needsProjectCount });
});

router.post("/api/gmail/poll", validateRequest({ body: z.object({}).strict().optional() }), async (_req, res) => {
  try {
    const result = await pollInbox();
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Poll failed: ${message}` });
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

router.get("/api/email-documents/:id", async (req, res) => {
  const doc = await storage.getEmailDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ message: "Document not found" });
  res.json(doc);
});

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

router.post(
  "/api/email-documents/:id/process",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      await processEmailDocument(Number(req.params.id));
      const updated = await storage.getEmailDocument(Number(req.params.id));
      res.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Processing failed: ${message}` });
    }
  },
);

export default router;
