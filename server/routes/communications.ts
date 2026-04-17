import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import {
  insertProjectCommunicationSchema,
  insertPaymentReminderSchema,
  type InsertProjectCommunication,
  type InsertPaymentReminder,
} from "@shared/schema";
import { upload } from "../middleware/upload";
import { sendCommunication } from "../communications/email-sender";
import { scheduleReminders } from "../communications/payment-scheduler";
import { uploadDocument } from "../storage/object-storage";
import { validateRequest } from "../middleware/validate";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const certIdParams = z.object({ certId: z.coerce.number().int().positive() });

const createCommBodySchema = insertProjectCommunicationSchema.omit({ projectId: true });
const updateReminderSchema = insertPaymentReminderSchema.partial();
const scheduleRemindersBodySchema = z.object({
  recipientEmail: z.string().email().optional().or(z.literal("")),
}).partial();

router.get("/api/communications", async (_req, res) => {
  const comms = await storage.getAllCommunications();
  res.json(comms);
});

router.get("/api/projects/:projectId/communications", async (req, res) => {
  const comms = await storage.getProjectCommunications(Number(req.params.projectId));
  res.json(comms);
});

router.post(
  "/api/projects/:projectId/communications",
  validateRequest({ params: projectIdParams, body: createCommBodySchema }),
  async (req, res) => {
    const comm = await storage.createProjectCommunication({
      ...req.body,
      projectId: Number(req.params.projectId),
    });
    res.status(201).json(comm);
  },
);

router.post(
  "/api/communications/:id/send",
  validateRequest({ params: idParams }),
  async (req, res) => {
    await sendCommunication(Number(req.params.id));
    const updated = await storage.getProjectCommunication(Number(req.params.id));
    res.json(updated);
  },
);

router.get("/api/projects/:projectId/reminders", async (req, res) => {
  const reminders = await storage.getPaymentReminders(Number(req.params.projectId));
  res.json(reminders);
});

router.post(
  "/api/certificats/:certId/schedule-reminders",
  validateRequest({ params: certIdParams, body: scheduleRemindersBodySchema }),
  async (req, res) => {
    await scheduleReminders(Number(req.params.certId), req.body.recipientEmail || "");
    const certificat = await storage.getCertificat(Number(req.params.certId));
    const reminders = certificat ? await storage.getPaymentReminders(certificat.projectId) : [];
    res.json(reminders);
  },
);

router.post(
  "/api/reminders/:id/cancel",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const reminder = await storage.updatePaymentReminder(Number(req.params.id), { status: "cancelled" });
    if (!reminder) return res.status(404).json({ message: "Reminder not found" });
    res.json(reminder);
  },
);

router.patch(
  "/api/reminders/:id",
  validateRequest({ params: idParams, body: updateReminderSchema }),
  async (req, res) => {
    const reminder = await storage.updatePaymentReminder(Number(req.params.id), req.body);
    if (!reminder) return res.status(404).json({ message: "Reminder not found" });
    res.json(reminder);
  },
);

router.get("/api/projects/:projectId/payment-evidence", async (req, res) => {
  const evidence = await storage.getClientPaymentEvidence(Number(req.params.projectId));
  res.json(evidence);
});

const evidenceUploadBodySchema = z.object({
  projectId: z.coerce.number().int().positive(),
  uploadedByEmail: z.string().email().optional(),
  invoiceId: z.coerce.number().int().positive().optional(),
  certificatId: z.coerce.number().int().positive().optional(),
  notes: z.string().optional(),
});

router.post(
  "/api/client-evidence/upload",
  upload.single("file"),
  validateRequest({ body: evidenceUploadBodySchema }),
  async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No file provided" });

    const { projectId, uploadedByEmail, invoiceId, certificatId, notes } = req.body;
    const storageKey = await uploadDocument(projectId, file.originalname, file.buffer, file.mimetype);
    const evidence = await storage.createClientPaymentEvidence({
      projectId,
      storageKey,
      fileName: file.originalname,
      uploadedByEmail: uploadedByEmail ?? null,
      invoiceId: invoiceId ?? null,
      certificatId: certificatId ?? null,
      notes: notes ?? null,
    });
    res.status(201).json(evidence);
  },
);

export default router;
