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
import { devis, clientChecks, type InsertDevis, type InsertClientCheck, type InsertWebhookEventIn, type InsertSignedPdfRetentionBreach, type Devis, type Project } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { uuidv7 } from "../lib/uuidv7";
import { enqueueWebhookDelivery } from "../services/webhook-delivery";
import type { OutboundEventType } from "../services/archidoc-webhook-client";

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
  // signedPdfFetchUrl snapshot, then enqueue the outbound
  // work_authorised delivery to Archidoc (AT5, §5.3.1).
  //
  // The transition is gated on signOffStage to keep the outbound
  // enqueue idempotent against AT4's own webhook redeliveries: a
  // duplicate `envelope.signed` after we've already moved the devis
  // returns 200 without re-firing the webhook (the inbound dedup row
  // already covers the wire-side dup; this guards against the
  // re-entry ordering where a row was deleted from `webhook_events_in`
  // out-of-band — defensive for a rare admin-edit case).
  const d = await storage.getDevisByArchisignEnvelopeId(p.envelopeId);
  if (!d) {
    return { status: 410, body: { message: "Unknown envelope", envelopeId: p.envelopeId } };
  }
  const isFreshTransition = d.signOffStage !== "client_signed_off";
  if (isFreshTransition) {
    const update: Partial<InsertDevis> = {
      signOffStage: "client_signed_off",
      archisignEnvelopeStatus: "signed",
      identityVerification: p.identityVerification,
      signedPdfFetchUrlSnapshot: p.signedPdfFetchUrl,
    };
    await storage.updateDevis(d.id, update);
  }

  // Enqueue the §5.3.1 work_authorised delivery. We only enqueue on
  // the fresh transition — a no-op duplicate would have its eventId
  // collide with the existing row anyway, but skipping the build path
  // saves an unnecessary lookup on every retry.
  if (isFreshTransition) {
    const reloaded = await storage.getDevis(d.id);
    await enqueueWorkAuthorised(reloaded ?? d, p);
  }

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
  // AT5: only fire the downstream notify on a fresh insert. The
  // (envelope_id, incident_ref) UNIQUE index makes
  // `recordSignedPdfRetentionBreach` return undefined on dup; we MUST
  // skip the enqueue in that case so a redelivered Archisign webhook
  // doesn't double-notify Archidoc. (Receiver-side dedup on eventId
  // also collapses dupes to 200, but skipping locally is cleaner.)
  if (inserted) {
    await enqueueRetentionBreach(d, p);
  }
  return {
    status: 200,
    body: {
      ok: true,
      devisId: d.id,
      breachRecorded: Boolean(inserted),
    },
  };
}

// --- Outbound enqueue helpers (AT5, §5.3) -------------------------------

/**
 * Build §5.3.1 work_authorised payload and enqueue a delivery row.
 * Logs and swallows failures — the inbound Archisign webhook MUST 200
 * once the local transition is persisted, even if the outbound surface
 * is down. Failed enqueues land in the DLQ for admin retry.
 */
async function enqueueWorkAuthorised(d: Devis, p: SignedPayload): Promise<void> {
  try {
    const project = await storage.getProject(d.projectId);
    const contractor = d.contractorId ? await storage.getContractor(d.contractorId) : undefined;
    const archidocProjectId = pickArchidocProjectId(project);

    // §5.3.1 omits insuranceOverride entirely when no override exists
    // (Archidoc treats absent as "no override on file"). Include only
    // when a row is present.
    const override = await storage.getLatestInsuranceOverrideForDevis(d.id);

    const eventId = uuidv7();
    const payload: { eventId: string; eventType: OutboundEventType } & Record<string, unknown> = {
      eventId,
      eventType: "work_authorised",
      architrakDevisId: d.id,
      projectId: d.projectId,
      archidocProjectId,
      contractorId: d.contractorId,
      contractorArchidocId: contractor?.archidocId ?? null,
      archisignEnvelopeId: p.envelopeId,
      signedAt: p.signedAt,
      identityVerification: p.identityVerification,
      dqeExportId: d.archidocDqeExportId ?? null,
    };
    if (override) {
      payload.insuranceOverride = {
        overriddenAt: override.createdAt instanceof Date
          ? override.createdAt.toISOString()
          : String(override.createdAt),
        overriddenByUserEmail: override.overriddenByUserEmail,
        reason: override.overrideReason,
      };
    }

    await enqueueOutboundDelivery({
      eventId,
      eventType: "work_authorised",
      payload,
      logContext: `devisId=${d.id} envelopeId=${p.envelopeId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[ArchisignWebhook] Failed to enqueue work_authorised for devisId=${d.id} envelopeId=${p.envelopeId}: ${message}`,
    );
  }
}

/**
 * Build §5.3.2 signed_pdf_retention_breach payload and enqueue. The
 * authoritative `originalSignedAt` is preserved verbatim from the
 * inbound payload — Archidoc relies on byte-equality with the prior
 * work_authorised.signedAt to correlate the breach.
 */
async function enqueueRetentionBreach(d: Devis, p: RetentionBreachPayload): Promise<void> {
  try {
    const project = await storage.getProject(d.projectId);
    const archidocProjectId = pickArchidocProjectId(project);
    const eventId = uuidv7();
    const payload: { eventId: string; eventType: OutboundEventType } & Record<string, unknown> = {
      eventId,
      eventType: "signed_pdf_retention_breach",
      architrakDevisId: d.id,
      projectId: d.projectId,
      archidocProjectId,
      archisignEnvelopeId: p.envelopeId,
      // Verbatim preservation: take from the inbound payload (string
      // ISO-8601 as-received), NOT a re-formatted Date round-trip.
      originalSignedAt: p.originalSignedAt,
      detectedAt: p.detectedAt,
      incidentRef: p.incidentRef,
      remediationContact: p.remediationContact,
    };
    await enqueueOutboundDelivery({
      eventId,
      eventType: "signed_pdf_retention_breach",
      payload,
      logContext: `devisId=${d.id} envelopeId=${p.envelopeId} incidentRef=${p.incidentRef}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[ArchisignWebhook] Failed to enqueue signed_pdf_retention_breach for devisId=${d.id} envelopeId=${p.envelopeId}: ${message}`,
    );
  }
}

interface OutboundEnqueueArgs {
  eventId: string;
  eventType: OutboundEventType;
  payload: { eventId: string; eventType: OutboundEventType } & Record<string, unknown>;
  logContext: string;
}

async function enqueueOutboundDelivery(args: OutboundEnqueueArgs): Promise<void> {
  const result = await enqueueWebhookDelivery({
    eventId: args.eventId,
    eventType: args.eventType,
    payload: args.payload,
  });
  if (result.skipped === "unconfigured") {
    // Already logged inside enqueueWebhookDelivery — keep AT4's inbound
    // path 200-clean.
    return;
  }
  if (!result.enqueued) {
    console.log(
      `[ArchisignWebhook] Outbound ${args.eventType} eventId=${args.eventId} ${args.logContext} already enqueued (idempotent no-op)`,
    );
  }
}

/**
 * §5.3 lets `archidocProjectId` be omitted when the upstream project
 * isn't yet linked to an Archidoc mirror; emit null in that case so
 * Archidoc's parser can branch deterministically on `=== null` vs
 * `=== undefined` (we always include the field).
 */
function pickArchidocProjectId(project: Project | undefined): string | null {
  if (!project) return null;
  return project.archidocId ?? null;
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
