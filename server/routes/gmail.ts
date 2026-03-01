import { Router } from "express";
import { storage } from "../storage";
import { getGmailMonitorStatus, pollInbox } from "../gmail/monitor";
import { processEmailDocument } from "../gmail/document-parser";

const router = Router();

router.get("/api/gmail/status", async (_req, res) => {
  res.json(getGmailMonitorStatus());
});

router.post("/api/gmail/poll", async (_req, res) => {
  try {
    const result = await pollInbox();
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Poll failed: ${message}` });
  }
});

router.get("/api/email-documents", async (req, res) => {
  const filters: any = {};
  if (req.query.projectId) filters.projectId = Number(req.query.projectId);
  if (req.query.status) filters.status = req.query.status as string;
  if (req.query.documentType) filters.documentType = req.query.documentType as string;
  const docs = await storage.getEmailDocuments(filters);
  res.json(docs);
});

router.get("/api/email-documents/:id", async (req, res) => {
  const doc = await storage.getEmailDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ message: "Document not found" });
  res.json(doc);
});

router.patch("/api/email-documents/:id", async (req, res) => {
  const doc = await storage.updateEmailDocument(Number(req.params.id), req.body);
  if (!doc) return res.status(404).json({ message: "Document not found" });
  res.json(doc);
});

router.post("/api/email-documents/:id/process", async (req, res) => {
  try {
    await processEmailDocument(Number(req.params.id));
    const updated = await storage.getEmailDocument(Number(req.params.id));
    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Processing failed: ${message}` });
  }
});

export default router;
