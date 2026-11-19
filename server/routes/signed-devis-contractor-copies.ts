import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { storage } from "../storage";
import {
  getSignedCopyNoticeForDevis,
  getSignedCopySetting,
  retrySignedCopyNotice,
  setSignedCopyEnabled,
  listSignedCopyDeliveriesForDevis,
} from "../services/signed-devis-contractor-copy.service";
import { matchesCurrentSignedCopy } from "../services/contractor-copy-card-status";
import { externalDeliveryBody, listExternalDeliveries, recordExternalDelivery } from "../services/contractor-external-delivery";
import {
  createManualSignedCopyDelivery,
  getSignedCopyContractorCopyPayload,
  retrySignedCopyDelivery,
} from "../services/manual-signed-devis-contractor-copy.service";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const deliveryParams = z.object({
  id: z.coerce.number().int().positive(),
  noticeId: z.coerce.number().int().positive(),
});
const settingBody = z.object({ enabled: z.boolean() }).strict();
const manualDeliveryBody = z.object({
  requestId: z.string().uuid(),
  confirmationToken: z.string().min(1),
}).strict();

// Lightweight card read: no PDF downloads, confirmation tokens or send side effects.
router.get("/api/devis/:id/contractor-copy-status", requireAuth,
  validateRequest({ params: idParams }), async (req, res) => {
    const d = await storage.getDevis(Number(req.params.id));
    if (!d) return res.status(404).json({ message: "Devis not found" });
    const notices = await listSignedCopyDeliveriesForDevis(d.id);
    const deliveries = await Promise.all(notices.map(async notice => {
      const comm = notice.communicationId ? await storage.getProjectCommunication(notice.communicationId) : undefined;
      return {
        id: notice.id, status: notice.status,
        currentDocument: matchesCurrentSignedCopy(d, notice, comm),
        recipientEmail: comm?.recipientEmail ?? null,
        sentAt: notice.sentAt ?? comm?.sentAt ?? null,
      };
    }));
    res.json({ deliveries, externalDeliveries: await listExternalDeliveries(d) });
  });

router.post("/api/devis/:id/contractor-copy/external", requireAuth,
  validateRequest({ params: idParams, body: externalDeliveryBody }), async (req, res) => {
    const devisId = Number(req.params.id);
    try {
      await recordExternalDelivery(devisId, req.session.userId!, req.body);
      res.json(await getSignedCopyContractorCopyPayload(devisId));
    } catch (error) {
      res.status(409).json({ message: error instanceof Error ? error.message : "Could not record external delivery." });
    }
  });

router.get("/api/settings/signed-dv-copies", requireAuth, async (_req, res) => {
  res.json(await getSignedCopySetting());
});

router.put(
  "/api/settings/signed-dv-copies",
  requireAuth,
  validateRequest({ body: settingBody }),
  async (req, res) => {
    res.json(await setSignedCopyEnabled(req.body.enabled));
  },
);

async function responseFor(devisId: number) {
  const notice = await getSignedCopyNoticeForDevis(devisId);
  if (!notice) return { notice: null };
  const communication = notice.communicationId
    ? await storage.getProjectCommunication(notice.communicationId)
    : undefined;
  return {
    notice: {
      id: notice.id,
      status: notice.status,
      recipientEmail: communication?.recipientEmail ?? null,
      sentAt: notice.sentAt?.toISOString() ?? communication?.sentAt?.toISOString() ?? null,
      lastError: notice.lastError,
      communicationId: notice.communicationId,
      canRetry:
        notice.status === "reconciling"
        || (notice.status === "failed" && communication?.status !== "sending"),
    },
  };
}

router.get(
  "/api/devis/:id/signed-copy-notice",
  requireAuth,
  validateRequest({ params: idParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    if (!await storage.getDevis(devisId)) return res.status(404).json({ message: "Devis not found" });
    res.json(await responseFor(devisId));
  },
);

router.post(
  "/api/devis/:id/signed-copy-notice/retry",
  requireAuth,
  validateRequest({ params: idParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    if (!await storage.getDevis(devisId)) return res.status(404).json({ message: "Devis not found" });
    try {
      const notice = await retrySignedCopyNotice(devisId);
      if (!notice) return res.status(404).json({ message: "Signed-copy notice not found" });
      res.json(await responseFor(devisId));
    } catch (error) {
      res.status(409).json({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.get(
  "/api/devis/:id/contractor-copy",
  requireAuth,
  validateRequest({ params: idParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    if (!await storage.getDevis(devisId)) return res.status(404).json({ message: "Devis not found" });
    res.json(await getSignedCopyContractorCopyPayload(devisId));
  },
);

router.post(
  "/api/devis/:id/contractor-copy",
  requireAuth,
  validateRequest({ params: idParams, body: manualDeliveryBody }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    if (!await storage.getDevis(devisId)) return res.status(404).json({ message: "Devis not found" });
    try {
      await createManualSignedCopyDelivery({
        devisId,
        requestId: req.body.requestId,
        confirmationToken: req.body.confirmationToken,
        requestedByUserId: req.session.userId!,
      });
      res.json(await getSignedCopyContractorCopyPayload(devisId));
    } catch (error) {
      res.status(409).json({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  "/api/devis/:id/contractor-copy/:noticeId/retry",
  requireAuth,
  validateRequest({ params: deliveryParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    if (!await storage.getDevis(devisId)) return res.status(404).json({ message: "Devis not found" });
    try {
      const noticeId = Number(req.params.noticeId);
      // The contractor-copy history includes automatic rows too. Delegate
      // the matching automatic row to its existing protected retry path;
      // manual-only retry logic must never be asked to mutate an automatic
      // notice.
      const automaticNotice = await getSignedCopyNoticeForDevis(devisId);
      const notice = automaticNotice?.id === noticeId
        ? await retrySignedCopyNotice(devisId)
        : await retrySignedCopyDelivery(noticeId, devisId);
      if (!notice || notice.devisId !== devisId) {
        return res.status(404).json({ message: "Signed-copy delivery not found" });
      }
      res.json(await getSignedCopyContractorCopyPayload(devisId));
    } catch (error) {
      res.status(409).json({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;