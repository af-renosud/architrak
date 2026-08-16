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

// Task #529 — the hub defaults to ACTIVE (non-archived) items; ?view=
// archived|all exposes the rest. Archive is a visibility flag only.
const viewQuerySchema = z.object({ view: z.enum(["active", "archived", "all"]).optional() });

router.get("/api/communications", validateRequest({ query: viewQuerySchema }), async (req, res) => {
  const view = (req.query.view as "active" | "archived" | "all" | undefined) ?? "active";
  const comms = await storage.getAllCommunications(view);
  res.json(comms);
});

router.post(
  "/api/communications/:id/archive",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const row = await storage.setCommunicationArchived(Number(req.params.id), true);
    if (!row) {
      const exists = await storage.getProjectCommunication(Number(req.params.id));
      if (!exists) return res.status(404).json({ message: "Communication introuvable" });
      return res.status(409).json({ code: "COMMUNICATION_QUEUED", message: "Un envoi en attente ne peut pas être archivé." });
    }
    res.json(row);
  },
);

router.post(
  "/api/communications/:id/unarchive",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const row = await storage.setCommunicationArchived(Number(req.params.id), false);
    if (!row) return res.status(404).json({ message: "Communication introuvable" });
    res.json(row);
  },
);

// Fresh-start bulk archive: preview counts first, then a confirmed run.
// Scope is strictly sent communications + reviewed suggestions older than
// the cutoff — failed/queued comms and open suggestions are never touched.
const cutoffQuerySchema = z.object({ cutoff: z.coerce.date() });
const cutoffBodySchema = z.object({
  cutoff: z.coerce.date(),
  // The preview token the operator confirmed (digest of the exact eligible
  // id set). The run is bound to it — ANY set drift, even with equal
  // counts, gets a 409 and archives NOTHING.
  token: z.string().min(1),
});

router.get(
  "/api/communications/fresh-start/preview",
  validateRequest({ query: cutoffQuerySchema }),
  async (req, res) => {
    // validateRequest already coerced ?cutoff= into a Date via zod.
    res.json(await storage.getFreshStartPreview(req.query.cutoff as unknown as Date));
  },
);

router.post(
  "/api/communications/fresh-start",
  validateRequest({ body: cutoffBodySchema }),
  async (req, res) => {
    const result = await storage.runFreshStartArchive(new Date(req.body.cutoff), req.body.token);
    if (result.outcome === "stale_preview") {
      return res.status(409).json({
        code: "FRESH_START_STALE_PREVIEW",
        message: "Le contenu a changé depuis l'aperçu — vérifiez les nouveaux comptes et confirmez à nouveau.",
        sentCommunications: result.sentCommunications,
        reviewedSuggestions: result.reviewedSuggestions,
        token: result.token,
      });
    }
    res.json({ archivedCommunications: result.archivedCommunications, archivedSuggestions: result.archivedSuggestions });
  },
);

// Task #521 — failed contractor notices grouped by contractor, so the hub
// can surface a single "retry all" action per contractor.
router.get("/api/failed-contractor-notices", async (_req, res) => {
  const groups = await storage.getFailedContractorNoticeGroups();
  res.json(groups);
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
    // Task #466 — send from the initiating architect's linked mailbox so
    // client replies can be scanned for payment confirmations.
    await sendCommunication(Number(req.params.id), { sentByUserId: req.session.userId ?? null });
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
