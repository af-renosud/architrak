import { Router } from "express";
import { storage } from "../storage";
import { insertProjectCommunicationSchema } from "@shared/schema";
import { upload } from "../middleware/upload";
import { sendCommunication } from "../communications/email-sender";
import { scheduleReminders } from "../communications/payment-scheduler";
import { uploadDocument } from "../storage/object-storage";

const router = Router();

router.get("/api/communications", async (_req, res) => {
  const comms = await storage.getAllCommunications();
  res.json(comms);
});

router.get("/api/projects/:projectId/communications", async (req, res) => {
  const comms = await storage.getProjectCommunications(Number(req.params.projectId));
  res.json(comms);
});

router.post("/api/projects/:projectId/communications", async (req, res) => {
  const data = { ...req.body, projectId: Number(req.params.projectId) };
  const parsed = insertProjectCommunicationSchema.safeParse(data);
  if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
  const comm = await storage.createProjectCommunication(parsed.data);
  res.status(201).json(comm);
});

router.post("/api/communications/:id/send", async (req, res) => {
  try {
    await sendCommunication(Number(req.params.id));
    const updated = await storage.getProjectCommunication(Number(req.params.id));
    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Send failed: ${message}` });
  }
});

router.get("/api/projects/:projectId/reminders", async (req, res) => {
  const reminders = await storage.getPaymentReminders(Number(req.params.projectId));
  res.json(reminders);
});

router.post("/api/certificats/:certId/schedule-reminders", async (req, res) => {
  try {
    const { recipientEmail } = req.body;
    await scheduleReminders(Number(req.params.certId), recipientEmail || "");
    const certificat = await storage.getCertificat(Number(req.params.certId));
    const reminders = certificat ? await storage.getPaymentReminders(certificat.projectId) : [];
    res.json(reminders);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Scheduling failed: ${message}` });
  }
});

router.post("/api/reminders/:id/cancel", async (req, res) => {
  const reminder = await storage.updatePaymentReminder(Number(req.params.id), { status: "cancelled" });
  if (!reminder) return res.status(404).json({ message: "Reminder not found" });
  res.json(reminder);
});

router.patch("/api/reminders/:id", async (req, res) => {
  const reminder = await storage.updatePaymentReminder(Number(req.params.id), req.body);
  if (!reminder) return res.status(404).json({ message: "Reminder not found" });
  res.json(reminder);
});

router.get("/api/projects/:projectId/payment-evidence", async (req, res) => {
  const evidence = await storage.getClientPaymentEvidence(Number(req.params.projectId));
  res.json(evidence);
});

router.post("/api/client-evidence/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No file provided" });

    const projectId = Number(req.body.projectId);
    if (!projectId) return res.status(400).json({ message: "Project ID required" });

    const storageKey = await uploadDocument(projectId, file.originalname, file.buffer, file.mimetype);
    const evidence = await storage.createClientPaymentEvidence({
      projectId,
      storageKey,
      fileName: file.originalname,
      uploadedByEmail: req.body.uploadedByEmail || null,
      invoiceId: req.body.invoiceId ? Number(req.body.invoiceId) : null,
      certificatId: req.body.certificatId ? Number(req.body.certificatId) : null,
      notes: req.body.notes || null,
    });
    res.status(201).json(evidence);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Upload failed: ${message}` });
  }
});

export default router;
