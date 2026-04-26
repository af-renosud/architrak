/**
 * Archisign inbound webhook receiver (AT4, contract §3.1 / §1.2).
 *
 * One route — POST /api/webhooks/archisign — verifies HMAC v2, claims a
 * `webhook_events_in` row for idempotency, then dispatches to one of seven
 * handlers via the addressable DISPATCH table (AT5 will extend this same
 * table for the downstream re-notification path on `retention_breach`).
 *
 * Idempotency-first: every handler runs ONLY after the dedup INSERT
 * returns true. Duplicate deliveries collapse to 200 {deduplicated:true}
 * per §1.5 ("dedup by eventId"). The handlers themselves are also
 * defensively idempotent — for example, retention_breach uses an
 * ON CONFLICT DO NOTHING insert as a belt-and-braces guard.
 *
 * Failure-mode contract (§1.5):
 *   - 200 within 5s on first delivery and on every retry
 *   - 401 on signature/timestamp issues (non-retryable from Archisign)
 *   - 410 on unknown envelope (non-retryable)
 *   - 5xx on any other handler failure (Archisign retry engages)
 *
 * The full common envelope (`event`, `eventId`, `timestamp`, `envelopeId`)
 * is parsed before dedup so we can fail fast on a malformed shape; only
 * `eventId` is actually used as the dedup key. Per-event tight schemas
 * run AFTER the dedup row is claimed so a malformed body still consumes
 * its eventId slot (preventing infinite Archisign retries on a stuck
 * payload).
 */

import express, { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { storage } from "../storage";
import { verifyArchisignWebhook } from "../middleware/archisign-webhook-auth";
import { db } from "../db";
import { devis, clientChecks, type InsertDevis, type InsertClientCheck, type InsertWebhookEventIn, type InsertSignedPdfRetentionBreach } from "@shared/schema";
import { eq, and } from "drizzle-orm";

const router = Router();

// 1 MiB cap matches the contract §3.9.1 defensive ceiling — express.raw
// returns 413 automatically once exceeded so the verifier never has to
// re-check it. `type: 'application/json'` keeps non-JSON bodies out of
// the buffer (they'd flow on as undefined, then fail the verifier).
const archisignRawJson = express.raw({ type: "application/json", limit: "1mb" });

// --- Common envelope shape (§3.2) ---------------------------------------
//
// All seven events share these four fields; per-event handlers parse the
// rest of the payload with a tighter zod schema.
const COMMON_ENVELOPE_SHAPE = z.object({
  event: z.enum([
    "envelope.sent",
    "envelope.queried",
    "envelope.query_resolved",
    "envelope.declined",
    "envelope.expired",
    "envelope.signed",
    "envelope.retention_breach",
  ]),
  eventId: z.string().min(1),
  timestamp: z.string().min(1),
  envelopeId: z.string().min(1),
});

// --- Per-event payload schemas (§3.2 / §3.3 / §3.4 / §3.7) --------------

const sentSchema = COMMON_ENVELOPE_SHAPE.extend({
  event: z.literal("envelope.sent"),
  sentAt: z.string(),
  signerEmail: z.string().email().optional(),
});

const queriedSchema = COMMON_ENVELOPE_SHAPE.extend({
  event: z.literal("envelope.queried"),
  queryEventId: z.string().min(1),
  queryText: z.string(),
  raisedAt: z.string(),
  signerEmail: z.string().email().optional(),
});

const queryResolvedSchema = COMMON_ENVELOPE_SHAPE.extend({
  event: z.literal("envelope.query_resolved"),
  queryEventId: z.string().min(1),
  resolvedAt: z.string(),
  resolverSource: z.enum(["architrak_internal", "archisign_admin_ui", "external"]),
  resolverEmail: z.string().email().nullable().optional(),
  resolverActor: z.enum(["architect", "system"]),
  resolutionNote: z.string().nullable().optional(),
});

const declinedSchema = COMMON_ENVELOPE_SHAPE.extend({
  event: z.literal("envelope.declined"),
  declinedAt: z.string(),
  declineReason: z.string(),
  declinedBy: z.string().optional(),
});

const expiredSchema = COMMON_ENVELOPE_SHAPE.extend({
  event: z.literal("envelope.expired"),
  expiredAt: z.string(),
});

const signedSchema = COMMON_ENVELOPE_SHAPE.extend({
  event: z.literal("envelope.signed"),
  signedAt: z.string(),
  signedPdfFetchUrl: z.string().url(),
  signedPdfFetchUrlExpiresAt: z.string(),
  // identityVerification is the 8-field block per §3.4. AT4 stores it
  // verbatim as jsonb; AT5 echoes it onto the work-authorisation webhook.
  // Pin a relaxed shape here (object) and let downstream consumers parse.
  identityVerification: z.record(z.unknown()),
});

const retentionBreachSchema = COMMON_ENVELOPE_SHAPE.extend({
  event: z.literal("envelope.retention_breach"),
  originalSignedAt: z.string(),
  detectedAt: z.string(),
  incidentRef: z.string().min(1),
  remediationContact: z.string().min(1),
});

type SentPayload = z.infer<typeof sentSchema>;
type QueriedPayload = z.infer<typeof queriedSchema>;
type QueryResolvedPayload = z.infer<typeof queryResolvedSchema>;
type DeclinedPayload = z.infer<typeof declinedSchema>;
type ExpiredPayload = z.infer<typeof expiredSchema>;
type SignedPayload = z.infer<typeof signedSchema>;
type RetentionBreachPayload = z.infer<typeof retentionBreachSchema>;

// --- Handler dispatch table (addressable for AT5) -----------------------

interface HandlerContext {
  payload: unknown;
}

type HandlerResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 410; body: Record<string, unknown> };

const DISPATCH: Record<string, {
  schema: z.ZodTypeAny;
  handle: (payload: any) => Promise<HandlerResult>;
}> = {
  "envelope.sent": { schema: sentSchema, handle: handleSent },
  "envelope.queried": { schema: queriedSchema, handle: handleQueried },
  "envelope.query_resolved": { schema: queryResolvedSchema, handle: handleQueryResolved },
  "envelope.declined": { schema: declinedSchema, handle: handleDeclined },
  "envelope.expired": { schema: expiredSchema, handle: handleExpired },
  "envelope.signed": { schema: signedSchema, handle: handleSigned },
  "envelope.retention_breach": { schema: retentionBreachSchema, handle: handleRetentionBreach },
};

// --- Lifecycle transition handlers (§1.2) -------------------------------

async function handleSent(p: SentPayload): Promise<HandlerResult> {
  // §1.2: stays at sent_to_client; updates archisignEnvelopeStatus.
  // Preserve the Archisign event timestamp verbatim — do not substitute
  // now() (G6 / scratchpad note: persist as-received).
  const d = await storage.getDevisByArchisignEnvelopeId(p.envelopeId);
  if (!d) {
    return { status: 410, body: { message: "Unknown envelope", envelopeId: p.envelopeId } };
  }
  const update: Partial<InsertDevis> = {
    archisignEnvelopeStatus: "sent",
  };
  await storage.updateDevis(d.id, update);
  return { status: 200, body: { ok: true, devisId: d.id, transition: "sent" } };
}

async function handleQueried(p: QueriedPayload): Promise<HandlerResult> {
  // §1.2: stays at sent_to_client; opens a client_checks row mirroring
  // the queryText, with originSource = archisign_query and
  // archisignQueryEventId populated. The dedup key is the inbound
  // eventId — we already passed that gate before getting here, so no
  // additional check needed inside this handler.
  const d = await storage.getDevisByArchisignEnvelopeId(p.envelopeId);
  if (!d) {
    return { status: 410, body: { message: "Unknown envelope", envelopeId: p.envelopeId } };
  }
  const statusUpdate: Partial<InsertDevis> = { archisignEnvelopeStatus: "queried" };
  await storage.updateDevis(d.id, statusUpdate);
  // Mirror as a client_checks row. openedAt = the Archisign-emitted
  // raisedAt timestamp (verbatim per §1.2).
  const newCheck: InsertClientCheck = {
    devisId: d.id,
    status: "open",
    queryText: p.queryText,
    originSource: "archisign_query",
    archisignQueryEventId: p.queryEventId,
    openedAt: new Date(p.raisedAt),
  };
  await storage.createClientCheck(newCheck);
  return { status: 200, body: { ok: true, devisId: d.id } };
}

async function handleQueryResolved(p: QueryResolvedPayload): Promise<HandlerResult> {
  // §1.2: stays at sent_to_client; closes the matching client_checks
  // row (looked up by archisignQueryEventId) and records the 4-field
  // attribution from §3.3.
  const d = await storage.getDevisByArchisignEnvelopeId(p.envelopeId);
  if (!d) {
    return { status: 410, body: { message: "Unknown envelope", envelopeId: p.envelopeId } };
  }
  const statusUpdate: Partial<InsertDevis> = { archisignEnvelopeStatus: "sent" };
  await storage.updateDevis(d.id, statusUpdate);
  // Find the matching open check. If none exists we return 200 anyway
  // — Archisign considers the resolved event delivered.
  const [match] = await db
    .select()
    .from(clientChecks)
    .where(and(
      eq(clientChecks.devisId, d.id),
      eq(clientChecks.archisignQueryEventId, p.queryEventId),
    ))
    .limit(1);
  if (match && match.status === "open") {
    const checkUpdate: Partial<InsertClientCheck> & { resolvedAt?: Date | null } = {
      status: "resolved",
      resolvedAt: new Date(p.resolvedAt),
      resolvedBySource: p.resolverSource,
      resolvedByUserEmail: p.resolverEmail ?? null,
      resolvedByActor: p.resolverActor,
      resolutionNote: p.resolutionNote ?? null,
    };
    await storage.updateClientCheck(match.id, checkUpdate);
  }
  return { status: 200, body: { ok: true, devisId: d.id, matched: Boolean(match) } };
}

async function handleDeclined(p: DeclinedPayload): Promise<HandlerResult> {
  // §1.2: sent_to_client → void. voidReason ← declineReason.
  const d = await storage.getDevisByArchisignEnvelopeId(p.envelopeId);
  if (!d) {
    return { status: 410, body: { message: "Unknown envelope", envelopeId: p.envelopeId } };
  }
  const update: Partial<InsertDevis> = {
    signOffStage: "void",
    voidReason: p.declineReason,
    archisignEnvelopeStatus: "declined",
  };
  await storage.updateDevis(d.id, update);
  return { status: 200, body: { ok: true, devisId: d.id, transition: "void" } };
}

async function handleExpired(p: ExpiredPayload): Promise<HandlerResult> {
  // §1.2: sent_to_client → approved_for_signing.
  //
  // Recovery mechanics: the architect must be able to start fresh after
  // an expiry, which means firing a NEW /create call (not a /send retry
  // against the dead envelopeId). To make both sides of the contract
  // honour that we:
  //   - clear archisignEnvelopeId so send-to-signer's resume guard
  //     (`if (envelopeId) skip /create`) does not fire
  //   - clear OTP destination + envelope expiry (no longer meaningful)
  //   - keep the prior accessUrl for audit, marked invalidated via
  //     archisignAccessUrlInvalidatedAt so the UI can render it crossed-out
  // Resend-after-expiry orchestration itself is out of scope for AT4 —
  // architect just sees the "Send to signer" CTA become live again.
  const d = await storage.getDevisByArchisignEnvelopeId(p.envelopeId);
  if (!d) {
    return { status: 410, body: { message: "Unknown envelope", envelopeId: p.envelopeId } };
  }
  const update: Partial<InsertDevis> = {
    signOffStage: "approved_for_signing",
    archisignEnvelopeStatus: "expired",
    archisignEnvelopeId: null,
    archisignOtpDestination: null,
    archisignEnvelopeExpiresAt: null,
    archisignAccessUrlInvalidatedAt: new Date(p.expiredAt),
  };
  await storage.updateDevis(d.id, update);
  return { status: 200, body: { ok: true, devisId: d.id, transition: "approved_for_signing" } };
}

async function handleSigned(p: SignedPayload): Promise<HandlerResult> {
  // §1.2: sent_to_client → client_signed_off. Persist
  // identityVerification (8-field block) verbatim and the
  // signedPdfFetchUrl snapshot. AT5 fires the outbound work-
  // authorisation webhook from here once it ships — for now the
  // transition itself is what AT4 owns.
  const d = await storage.getDevisByArchisignEnvelopeId(p.envelopeId);
  if (!d) {
    return { status: 410, body: { message: "Unknown envelope", envelopeId: p.envelopeId } };
  }
  const update: Partial<InsertDevis> = {
    signOffStage: "client_signed_off",
    archisignEnvelopeStatus: "signed",
    identityVerification: p.identityVerification,
    signedPdfFetchUrlSnapshot: p.signedPdfFetchUrl,
  };
  await storage.updateDevis(d.id, update);
  return { status: 200, body: { ok: true, devisId: d.id, transition: "client_signed_off" } };
}

async function handleRetentionBreach(p: RetentionBreachPayload): Promise<HandlerResult> {
  // §1.2: stays at client_signed_off (logically terminal). Inserts a
  // signed_pdf_retention_breaches row. Belt-and-braces UNIQUE on
  // (envelope_id, incident_ref) handles any race; downstream re-
  // notify (AT5) is gated on a fresh insert returning a row.
  const d = await storage.getDevisByArchisignEnvelopeId(p.envelopeId);
  if (!d) {
    return { status: 410, body: { message: "Unknown envelope", envelopeId: p.envelopeId } };
  }
  const breach: InsertSignedPdfRetentionBreach = {
    devisId: d.id,
    archisignEnvelopeId: p.envelopeId,
    eventSource: "archisign",
    originalSignedAt: new Date(p.originalSignedAt),
    detectedAt: new Date(p.detectedAt),
    incidentRef: p.incidentRef,
    remediationContact: p.remediationContact,
  };
  const inserted = await storage.recordSignedPdfRetentionBreach(breach);
  return {
    status: 200,
    body: {
      ok: true,
      devisId: d.id,
      breachRecorded: Boolean(inserted),
      // AT5 will read this same response and decide whether to fire the
      // downstream re-notify based on `breachRecorded`.
    },
  };
}

// --- Route handler ------------------------------------------------------

router.post(
  "/api/webhooks/archisign",
  archisignRawJson,
  verifyArchisignWebhook,
  async (req: Request, res: Response) => {
  // Parse the common envelope first so we can dedup BEFORE running any
  // event-specific schema (cheap pre-check). If parsing fails we return
  // 400 — Archisign treats 4xx as non-retryable per §1.5, which matches
  // "the payload is malformed; retrying won't help".
  const baseParse = COMMON_ENVELOPE_SHAPE.safeParse(req.body);
  if (!baseParse.success) {
    return res.status(400).json({
      message: "Malformed Archisign event envelope",
      errors: baseParse.error.flatten(),
    });
  }
  const { event, eventId } = baseParse.data;

  // Dedup-first. Hash the raw body for the `payload_hash` column so we
  // can investigate any future "different payload, same eventId"
  // anomalies without storing the full body. The verifier stashed the
  // raw bytes on req.rawBody after a successful HMAC check.
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const payloadHash = rawBody
    ? crypto.createHash("sha256").update(rawBody).digest("hex")
    : crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex");

  const dedupRow: InsertWebhookEventIn = {
    source: "archisign",
    eventId,
    eventType: event,
    payloadHash,
  };
  const claimed = await storage.claimWebhookEventIn(dedupRow);
  if (!claimed) {
    return res.status(200).json({ deduplicated: true, eventId, event });
  }

  // Now run the per-event schema check. A schema mismatch on a brand-
  // new event is a 400 — Archisign's retry won't fix it. We deliberately
  // do NOT roll back the dedup row: this preserves the at-least-once
  // promise (next delivery of the same eventId still 200s as
  // deduplicated) and lets us investigate the malformed payload
  // out-of-band.
  const dispatch = DISPATCH[event];
  const tightParse = dispatch.schema.safeParse(req.body);
  if (!tightParse.success) {
    console.warn(`[ArchisignWebhook] Tight-schema mismatch for ${event} eventId=${eventId}`, tightParse.error.flatten());
    return res.status(400).json({
      message: `Malformed ${event} payload`,
      errors: tightParse.error.flatten(),
    });
  }

  try {
    const result = await dispatch.handle(tightParse.data);
    return res.status(result.status).json(result.body);
  } catch (err) {
    // Per §1.5: handler errors map to 5xx so Archisign's retry engages.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ArchisignWebhook] Handler error for ${event} eventId=${eventId}:`, message);
    return res.status(500).json({ message: `Webhook handler failed: ${message}` });
  }
});

export default router;
