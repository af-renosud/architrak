import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { getGmailMonitorStatus, pollInbox } from "../gmail/monitor";
import { processEmailDocument } from "../gmail/document-parser";
import { insertEmailDocumentSchema, type InsertEmailDocument } from "@shared/schema";
import { validateRequest } from "../middleware/validate";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const updateEmailDocSchema = insertEmailDocumentSchema.partial();
const emailDocsQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  status: z.string().optional(),
  documentType: z.string().optional(),
});

router.get("/api/gmail/status", async (_req, res) => {
  res.json(getGmailMonitorStatus());
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
