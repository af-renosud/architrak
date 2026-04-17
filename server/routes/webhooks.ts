import { Router } from "express";
import { verifyWebhookSignature } from "../middleware/webhook-auth";
import { webhookEventSchema, processWebhookEvent } from "../services/webhook.service";
import { validateRequest } from "../middleware/validate";
import type { z } from "zod";

const router = Router();

router.post(
  "/api/webhooks/archidoc",
  verifyWebhookSignature,
  validateRequest({ body: webhookEventSchema }),
  async (req, res) => {
    try {
      const result = await processWebhookEvent(req.body);
      console.log(`[Webhook] Event processed: ${result.event} — ${result.details}`);
      res.status(200).json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Webhook] Processing error:", message);
      res.status(500).json({ message: `Webhook processing failed: ${message}` });
    }
  },
);

export default router;
