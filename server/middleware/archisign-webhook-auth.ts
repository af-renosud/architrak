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
 * where:
 *   - timestamp  is the unix-ms digit string from X-Archisign-Timestamp,
 *                used VERBATIM in the signed input (no normalisation)
 *   - rawBody    is the request body bytes exactly as received
 *
 * The route registers `express.raw({ type: 'application/json', limit: '1mb' })`
 * so `req.body` is a Buffer at the time this verifier runs. After a
 * successful verification we JSON.parse the buffer and replace `req.body`
 * with the parsed object so downstream handlers can read it normally.
 *
 * Verifier outcomes:
 *   - secret unset                        → 503 (config error, not auth error)
 *   - body > 1 MiB (express.raw 413)      → 413 (handled by express.raw)
 *   - missing/non-Buffer req.body         → 401
 *   - missing X-Archisign-Signature       → 401
 *   - missing X-Archisign-Timestamp       → 401
 *   - timestamp not unix-ms digit string  → 401
 *   - timestamp outside ±5min skew        → 401
 *   - signature missing sha256= prefix    → 401 (strict v2)
 *   - signature mismatch                  → 401
 *   - body fails JSON.parse post-verify   → 400
 *
 * The 401 status applies uniformly to ALL signature/timestamp failures so
 * Archisign's retry logic does not engage on auth issues (§1.5: "401 on
 * signature/timestamp issues — non-retryable from Archisign's view").
 */

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../env";

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
// Lower bound of acceptable unix-ms values. Anything below this (e.g. a
// stray unix-seconds value) gets rejected as malformed before we even
// compute skew. 10^12 ms ≈ 2001-09-09; well below any realistic clock.
const MIN_UNIX_MS = 1_000_000_000_000;

export function verifyArchisignWebhook(req: Request, res: Response, next: NextFunction) {
  const secret = env.ARCHISIGN_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[ArchisignWebhook] ARCHISIGN_WEBHOOK_SECRET is not configured — returning 503");
    return res.status(503).json({ message: "Archisign webhook secret not configured" });
  }

  // express.raw() leaves the raw bytes on req.body. Empty-body requests
  // surface as `{}` (Express oddity) — guard against both.
  const rawBody = req.body;
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    console.warn("[ArchisignWebhook] req.body is not a Buffer — express.raw() not mounted on this route?");
    return res.status(401).json({ message: "Missing webhook body" });
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

  // Timestamp format: unix-ms digit string. Strict — must be all digits
  // (no ISO, no decimals, no whitespace). The exact string is what gets
  // signed, so any normalisation here would diverge from the sender's
  // signed input.
  if (!/^\d{13,}$/.test(timestamp)) {
    console.warn(`[ArchisignWebhook] X-Archisign-Timestamp ${timestamp} is not a unix-ms digit string — 401`);
    return res.status(401).json({ message: "Invalid webhook timestamp" });
  }
  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs) || tsMs < MIN_UNIX_MS) {
    console.warn(`[ArchisignWebhook] Unparseable X-Archisign-Timestamp ${timestamp} — 401`);
    return res.status(401).json({ message: "Invalid webhook timestamp" });
  }
  const skew = Math.abs(Date.now() - tsMs);
  if (skew > TIMESTAMP_TOLERANCE_MS) {
    console.warn(`[ArchisignWebhook] Timestamp skew ${skew}ms exceeds ±${TIMESTAMP_TOLERANCE_MS}ms — 401 (replay protection)`);
    return res.status(401).json({ message: "Webhook timestamp outside acceptable window" });
  }

  // Strict v2: signature MUST carry the `sha256=` prefix. No bare-hex
  // tolerance — keeps the verifier born-strict so a misconfigured sender
  // fails loudly during integration rather than silently sliding by.
  if (!signature.startsWith("sha256=")) {
    console.warn(`[ArchisignWebhook] Signature missing sha256= prefix — 401 (strict v2)`);
    return res.status(401).json({ message: "Malformed webhook signature" });
  }
  const providedHex = signature.slice("sha256=".length);
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

  // Stash the raw bytes in case a downstream handler needs them, then
  // parse the JSON and replace req.body so handlers see the parsed
  // object as they would behind a regular express.json() mount.
  (req as Request & { rawBody?: Buffer }).rawBody = rawBody;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[ArchisignWebhook] Body failed JSON.parse post-verify — 400: ${detail}`);
    return res.status(400).json({ message: "Webhook body is not valid JSON" });
  }
  req.body = parsed;
  next();
}
