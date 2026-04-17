import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../env";

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export function verifyWebhookSignature(req: Request, res: Response, next: NextFunction) {
  const secret = env.ARCHIDOC_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[Webhook] ARCHIDOC_WEBHOOK_SECRET is not configured");
    return res.status(401).json({ message: "Webhook secret not configured" });
  }

  const signatureHeader = req.headers["x-archidoc-signature"] as string | undefined;
  if (!signatureHeader) {
    console.warn("[Webhook] Missing X-Archidoc-Signature header");
    return res.status(401).json({ message: "Missing webhook signature" });
  }

  const parts = signatureHeader.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") {
    console.warn("[Webhook] Malformed signature header:", signatureHeader);
    return res.status(401).json({ message: "Malformed webhook signature" });
  }

  const providedSignature = parts[1];

  const rawBody = (req as any).rawBody;
  if (!rawBody) {
    console.error("[Webhook] Raw body not available — verify express.json() has verify callback");
    return res.status(500).json({ message: "Server configuration error: raw body unavailable" });
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const providedBuffer = Buffer.from(providedSignature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    console.warn("[Webhook] Invalid signature — rejecting request");
    return res.status(401).json({ message: "Invalid webhook signature" });
  }

  const body = req.body;
  if (!body || !body.timestamp) {
    console.warn("[Webhook] Missing timestamp in payload — rejecting for replay protection");
    return res.status(400).json({ message: "Missing timestamp in webhook payload" });
  }

  const eventTime = new Date(body.timestamp).getTime();
  const now = Date.now();
  if (isNaN(eventTime)) {
    console.warn("[Webhook] Invalid timestamp in payload:", body.timestamp);
    return res.status(400).json({ message: "Invalid timestamp in webhook payload" });
  }
  if (Math.abs(now - eventTime) > TIMESTAMP_TOLERANCE_MS) {
    console.warn(`[Webhook] Replay attack rejected — event timestamp ${body.timestamp} is outside ${TIMESTAMP_TOLERANCE_MS / 1000}s tolerance`);
    return res.status(401).json({ message: "Webhook timestamp outside acceptable window" });
  }

  next();
}
