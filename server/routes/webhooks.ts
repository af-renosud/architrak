import { Router } from "express";
import { verifyWebhookSignature } from "../middleware/webhook-auth";
import { webhookEventSchema, processWebhookEvent } from "../services/webhook.service";

const router = Router();

router.post("/api/webhooks/archidoc", verifyWebhookSignature, async (req, res) => {
  try {
    const parsed = webhookEventSchema.safeParse(req.body);
    if (!parsed.success) {
      console.warn("[Webhook] Invalid payload:", parsed.error.flatten());
      return res.status(400).json({
        message: "Invalid webhook payload",
        errors: parsed.error.flatten(),
      });
    }

    const result = await processWebhookEvent(parsed.data);
    console.log(`[Webhook] Event processed: ${result.event} — ${result.details}`);
    res.status(200).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Webhook] Processing error:", message);
    res.status(500).json({ message: `Webhook processing failed: ${message}` });
  }
});

export default router;
