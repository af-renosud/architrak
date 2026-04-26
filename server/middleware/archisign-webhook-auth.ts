/**
 * Archisign HMAC v2 verifier (AT4, contract §3.9.1).
 *
 * Born v2-only — there is NO migration on this channel because the
 * `/api/webhooks/archisign` endpoint is net-new in AT4 (§2.4: Architrak's
 * row in the migration matrix is "N/A — born v2"). Distinct from the
 * Archidoc-flavoured v1 verifier in `webhook-auth.ts` which lives on the
 * pre-existing `/api/webhooks/archidoc` channel and stays untouched.
 *
 * Algorithm (byte-identical across all three apps per §3.10):
 *   sig = "sha256=" + hmac_sha256(secret, `${timestamp}.${rawBody}`)
 * where rawBody is the bytes of the request body exactly as received.
 *
 * Verifier outcomes:
 *   - secret unset                        → 503 (config error, not auth error)
 *   - body > 1 MiB                        → 413 (defensive cap)
 *   - missing X-Archisign-Signature       → 401
 *   - missing X-Archisign-Timestamp       → 401
 *   - timestamp outside ±5min skew        → 401
 *   - signature mismatch                  → 401
 *   - rawBody not captured                → 500 (server bug)
 *
 * The 401 status applies uniformly to ALL signature/timestamp failures so
 * Archisign's retry logic does not engage on auth issues (§1.5: "401 on
 * signature/timestamp issues — non-retryable from Archisign's view").
 */

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../env";

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 1 * 1024 * 1024;

export function verifyArchisignWebhook(req: Request, res: Response, next: NextFunction) {
  const secret = env.ARCHISIGN_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[ArchisignWebhook] ARCHISIGN_WEBHOOK_SECRET is not configured — returning 503");
    return res.status(503).json({ message: "Archisign webhook secret not configured" });
  }

  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody || !(rawBody instanceof Buffer)) {
    console.error("[ArchisignWebhook] Raw body buffer not captured — express.json verify callback may be misconfigured");
    return res.status(500).json({ message: "Server configuration error: raw body unavailable" });
  }

  if (rawBody.length > MAX_BODY_BYTES) {
    console.warn(`[ArchisignWebhook] Body ${rawBody.length}B exceeds ${MAX_BODY_BYTES}B cap — returning 413`);
    return res.status(413).json({ message: "Webhook payload too large" });
  }

  const sigHeader = req.headers["x-archisign-signature"];
  const tsHeader = req.headers["x-archisign-timestamp"];
  const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;

  if (!signature || typeof signature !== "string") {
    console.warn("[ArchisignWebhook] Missing X-Archisign-Signature — 401");
    return res.status(401).json({ message: "Missing webhook signature" });
  }
  if (!timestamp || typeof timestamp !== "string") {
    console.warn("[ArchisignWebhook] Missing X-Archisign-Timestamp — 401");
    return res.status(401).json({ message: "Missing webhook timestamp" });
  }

  // Timestamp format: ISO 8601 (the contract is symmetric — any parseable
  // form gets normalised to ms; we accept ISO since that's what §3.9.1
  // specifies). Reject ±5min outside skew.
  const tsMs = Date.parse(timestamp);
  if (!Number.isFinite(tsMs)) {
    console.warn(`[ArchisignWebhook] Unparseable X-Archisign-Timestamp ${timestamp} — 401`);
    return res.status(401).json({ message: "Invalid webhook timestamp" });
  }
  const skew = Math.abs(Date.now() - tsMs);
  if (skew > TIMESTAMP_TOLERANCE_MS) {
    console.warn(`[ArchisignWebhook] Timestamp skew ${skew}ms exceeds ±${TIMESTAMP_TOLERANCE_MS}ms — 401 (replay protection)`);
    return res.status(401).json({ message: "Webhook timestamp outside acceptable window" });
  }

  // Parse signature header — accept either bare hex or `sha256=<hex>` form
  // since the contract example shows the prefixed form but the algorithm
  // is unambiguous (only sha256 is defined in v2). Symmetric across apps
  // per §3.9.1: prefixed form is the canonical one.
  let providedHex = signature;
  if (signature.startsWith("sha256=")) {
    providedHex = signature.slice("sha256=".length);
  } else {
    console.warn(`[ArchisignWebhook] Signature missing sha256= prefix — 401 (strict v2)`);
    return res.status(401).json({ message: "Malformed webhook signature" });
  }
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
    console.warn(`[ArchisignWebhook] Signature is not 64 hex chars — 401`);
    return res.status(401).json({ message: "Malformed webhook signature" });
  }

  // Compute expected. The signed input is `${timestamp}.${rawBody}` with
  // rawBody as raw bytes (Buffer concat — NOT string-coerced, to preserve
  // byte-exactness for non-ASCII payloads).
  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]))
    .digest("hex");

  const provided = Buffer.from(providedHex.toLowerCase(), "hex");
  const expected = Buffer.from(expectedHex.toLowerCase(), "hex");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    console.warn("[ArchisignWebhook] Signature mismatch — 401");
    return res.status(401).json({ message: "Invalid webhook signature" });
  }

  next();
}
