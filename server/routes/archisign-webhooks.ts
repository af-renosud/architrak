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
import { canonicalizeTimestamp } from "../lib/canonical-timestamp";
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
//
// Two wire-shape conformance notes from the 2026-05-07 Archisign joint
// debug session (see chat thread for the full exchange):
//
//   - The per-event time field is named `occurredAt` per §3.2 / §3.4
//     ("receivers must use occurredAt for ordering and eventId for
//     dedup"), NOT `timestamp`. Architrak previously mis-spelled it as
//     `timestamp`; the rename is safe because no handler reads it (the
//     per-event schemas carry their own typed time field — `sentAt`,
//     `signedAt`, etc. — that the handlers actually use).
//
//   - `envelopeId` is emitted by Archisign as a JSON number, not a
//     string. We coerce on parse via `z.coerce.string()` so downstream
//     storage lookups (`getDevisByArchisignEnvelopeId`, which keys off
//     a text column) keep working without a parallel int code path.
//     Same class of bug as the /create response parser fix shipped
//     immediately prior — outbound was patched, inbound also needed it.
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
  occurredAt: z.string().min(1),
  envelopeId: z.coerce.string().min(1),
}).passthrough();

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
    // §5.3.1 fixture-pinned shape — contractor is loaded only so the
    // log message can include human context if a future debug path
    // wants it; the payload itself echoes only contract-listed fields.
    void contractor;
    // §5.3.2.1 (v1.1) sender-side canonicalization at the relay
    // boundary: the upstream Archisign body may carry the seconds-only
    // `...Z` form, but Archidoc's byte-equality correlation rule
    // requires the `.SSSZ` form on the §5.3.1 work_authorised → §5.3.2
    // breach round-trip. We canonicalize both the top-level `signedAt`
    // and the `identityVerification.signedAt` subfield (the two §5.3.1
    // fields enumerated in the §5.3.2.1 conformance table). Other
    // identityVerification timestamp fields (otpIssuedAt, otpVerifiedAt,
    // lastViewedAt) are out of §5.3.2.1 scope — they don't participate
    // in the byte-equality rule — and we leave them verbatim.
    //
    // Strict precondition on `identityVerification.signedAt`: §5.3.2.1
    // mandates this field MUST be emitted in canonical form, so a
    // missing or non-string value is a contract violation we surface
    // immediately rather than silently relaying. The signedSchema only
    // pins identityVerification as `z.record(z.unknown())` (relaxed by
    // design — AT4 stores the 8-field block verbatim as jsonb), so the
    // assertion lives here at the AT5 emission boundary where the
    // mandate actually applies. The throw is captured by the catch
    // block below and emitted with a `[CanonicalizationError]` marker
    // for log-grep visibility.
    const inboundIvSignedAt = (p.identityVerification as Record<string, unknown>).signedAt;
    if (typeof inboundIvSignedAt !== "string") {
      throw new Error(
        `[CanonicalizationError] identityVerification.signedAt is missing or not a string ` +
          `(received ${JSON.stringify(inboundIvSignedAt)}); §5.3.2.1 mandates this field MUST ` +
          `be emitted on §5.3.1 work_authorised in canonical .SSSZ form.`,
      );
    }
    const canonicalIdentityVerification: Record<string, unknown> = { ...p.identityVerification };
    canonicalIdentityVerification.signedAt = canonicalizeTimestamp(inboundIvSignedAt);
    const payload: { eventId: string; eventType: OutboundEventType } & Record<string, unknown> = {
      eventId,
      eventType: "work_authorised",
      architrakDevisId: d.id,
      projectId: d.projectId,
      archidocProjectId,
      contractorId: d.contractorId,
      archisignEnvelopeId: p.envelopeId,
      signedAt: canonicalizeTimestamp(p.signedAt),
      identityVerification: canonicalIdentityVerification,
      dqeExportId: d.archidocDqeExportId ?? null,
    };
    if (override) {
      // §5.3.1 insuranceOverride block: full AT3 audit row echoed
      // verbatim (mirror status snapshot, live-verdict response, the
      // overriding user's email). All seven fields are NOT NULL on the
      // insurance_overrides table, so we don't need null-coalescing
      // here — but cast `liveVerdictResponse` from `unknown` to make
      // the JSON-serialisable contract explicit.
      payload.insuranceOverride = {
        overrideReason: override.overrideReason,
        mirrorStatusAtOverride: override.mirrorStatusAtOverride,
        mirrorSyncedAtAtOverride: override.mirrorSyncedAtAtOverride instanceof Date
          ? override.mirrorSyncedAtAtOverride.toISOString()
          : String(override.mirrorSyncedAtAtOverride),
        liveVerdictHttpStatus: override.liveVerdictHttpStatus,
        liveVerdictCanProceed: override.liveVerdictCanProceed,
        liveVerdictResponse: override.liveVerdictResponse,
        overriddenByUserEmail: override.overriddenByUserEmail,
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
 * authoritative `originalSignedAt` is canonicalized at the relay
 * boundary per §5.3.2.1 (v1.1) — Archidoc relies on byte-equality with
 * the prior `work_authorised.signedAt` (which we also canonicalized
 * before emission, and which Postgres `timestamptz` then stored in the
 * same `.SSSZ` form). The instant is preserved; only the wire
 * representation is normalised.
 */
async function enqueueRetentionBreach(d: Devis, p: RetentionBreachPayload): Promise<void> {
  try {
    const project = await storage.getProject(d.projectId);
    const archidocProjectId = pickArchidocProjectId(project);
    const eventId = uuidv7();
    // §5.3.2 fixture-pinned shape — `projectId` is intentionally NOT
    // emitted on the breach payload (the receiver correlates by
    // `architrakDevisId` + `archisignEnvelopeId` + `originalSignedAt`).
    void d.projectId;
    const payload: { eventId: string; eventType: OutboundEventType } & Record<string, unknown> = {
      eventId,
      eventType: "signed_pdf_retention_breach",
      architrakDevisId: d.id,
      archisignEnvelopeId: p.envelopeId,
      archidocProjectId,
      incidentRef: p.incidentRef,
      remediationContact: p.remediationContact,
      // §5.3.2.1 (v1.1) sender-side canonicalization: emit the
      // `.SSSZ` form regardless of whether the inbound Archisign body
      // carried the seconds-only `...Z` shape. This is the third of
      // the three fields enumerated in the §5.3.2.1 conformance table,
      // and the exact field that triggered the 2026-05-02 joint live
      // E2E test postmortem (Architrak's `...Z` vs Archidoc's
      // Postgres-normalised `...000Z`). `detectedAt` is NOT in §5.3.2.1
      // scope — it does not participate in the byte-equality rule —
      // and we relay it verbatim.
      originalSignedAt: canonicalizeTimestamp(p.originalSignedAt),
      detectedAt: p.detectedAt,
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
    // Environment-gating decision (NOT a violation of §1.4 hard-fail):
    // the soft-skip ONLY triggers when no Archidoc URL is set at all
    // (`isOutboundOperational()` is false), i.e. local dev / CI where
    // there is genuinely no Archidoc target to dispatch to. In a
    // configured env where the URL is set but the secret is missing,
    // enqueue still proceeds — the dispatch path then hard-fails,
    // dead-letters the row, and fires `sendOperatorAlert(...)` so the
    // misconfiguration surfaces loudly in the admin DLQ + on-call inbox.
    // Either way, AT4's inbound channel returns 200 (an inbound 500
    // would only make Archisign retry, which doesn't fix our env).
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
