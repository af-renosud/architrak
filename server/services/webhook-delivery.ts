/**
 * Outbound webhook delivery orchestrator (AT5, contract §1.4 + §2.1.6).
 *
 * Wraps `archidoc-webhook-client.ts`'s single-attempt POST with the
 * retry + dead-letter state machine persisted in `webhook_deliveries_out`.
 *
 * Race-safe enqueue: callers pass a stable `eventId` (UUIDv7 minted
 * upstream — G6) and the storage layer enforces ON CONFLICT DO NOTHING.
 * Re-emitting the same logical event observes the existing row instead
 * of double-posting.
 *
 * Retry policy (§1.4):
 *   - 3 attempts total
 *   - 1s / 4s / 16s exponential backoff with ±20% jitter
 *   - Per-attempt 10s HTTP timeout (enforced inside the client)
 *   - 4xx (non-429) → dead-letter immediately (skip remaining attempts)
 *   - 5xx + network errors + 429 → retry; 429 honours Retry-After
 *
 * Sweeper: an in-process setInterval drains `state=pending AND
 * next_attempt_at <= now()` rows every 30s. The first attempt is
 * dispatched inline by the enqueue caller as a fire-and-forget; the
 * sweeper handles every subsequent retry plus any pending row that
 * survived a process restart.
 */

import type { WebhookDeliveryOut } from "@shared/schema";
import { storage } from "../storage";
import {
  ArchidocWebhookConfigError,
  ArchidocWebhookPayloadTooLargeError,
  isOutboundDeliveryConfigured,
  postWorkAuthorisation,
  type DeliveryOutcome,
  type OutboundEventType,
} from "./archidoc-webhook-client";

export const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_FACTOR = 4;
const JITTER_PCT = 0.2;
const SWEEPER_INTERVAL_MS = 30_000;
const SWEEPER_BATCH = 25;

interface EnqueueArgs {
  eventId: string;
  eventType: OutboundEventType;
  payload: { eventId: string; eventType: OutboundEventType } & Record<string, unknown>;
  /**
   * Override the resolved `getWorkAuthorisationUrl()` — handy for
   * future per-tenant scoping. Production callers omit this.
   */
  targetUrl?: string;
  /**
   * When true (default), the orchestrator triggers an immediate first
   * attempt as a fire-and-forget after the row is claimed. Set to
   * false in tests to inspect the row state before dispatch.
   */
  triggerImmediately?: boolean;
}

export interface EnqueueResult {
  delivery: WebhookDeliveryOut;
  enqueued: boolean;
  /** true when the outbound surface isn't configured — row was NOT inserted. */
  skipped?: "unconfigured";
}

/**
 * Race-safe claim. Returns the row that the receiver will use for
 * tracking; the boolean `enqueued` is false when an existing row
 * (same eventId) was observed instead of inserted.
 *
 * Soft-fail when ARCHITRAK_WEBHOOK_SECRET / ARCHIDOC_BASE_URL are
 * unset: we don't insert a DLQ row that we know we cannot dispatch.
 * AT4's inbound handler logs and returns 200 in that case (the
 * Architrak operator's job is to provision the env var; an inbound
 * 500 would only make Archisign retry, which doesn't help us here).
 */
export async function enqueueWebhookDelivery(args: EnqueueArgs): Promise<EnqueueResult> {
  if (!isOutboundDeliveryConfigured()) {
    console.warn(
      `[WebhookDelivery] Outbound surface not configured — skipping enqueue eventId=${args.eventId} eventType=${args.eventType}. ` +
        `Set ARCHITRAK_WEBHOOK_SECRET and ARCHIDOC_BASE_URL (or ARCHIDOC_WORK_AUTH_URL) to enable.`,
    );
    // Synthesise a sentinel return — no row is inserted, caller should
    // not consult delivery.* fields when skipped is set.
    const sentinel: WebhookDeliveryOut = {
      id: 0,
      eventId: args.eventId,
      eventType: args.eventType,
      targetUrl: args.targetUrl ?? "",
      payload: args.payload,
      state: "pending",
      attemptCount: 0,
      lastAttemptAt: null,
      lastErrorBody: null,
      nextAttemptAt: null,
      succeededAt: null,
      deadLetteredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return { delivery: sentinel, enqueued: false, skipped: "unconfigured" };
  }

  // Resolve the target URL once at enqueue time (we record it so admin
  // retries hit the SAME endpoint even if env changed in between).
  let targetUrl: string;
  try {
    const { getWorkAuthorisationUrl } = await import("./archidoc-webhook-client");
    targetUrl = args.targetUrl ?? getWorkAuthorisationUrl();
  } catch (err) {
    if (err instanceof ArchidocWebhookConfigError) {
      console.warn(`[WebhookDelivery] URL resolution failed for eventId=${args.eventId}: ${err.message}`);
      return {
        delivery: {
          id: 0,
          eventId: args.eventId,
          eventType: args.eventType,
          targetUrl: "",
          payload: args.payload,
          state: "pending",
          attemptCount: 0,
          lastAttemptAt: null,
          lastErrorBody: null,
          nextAttemptAt: null,
          succeededAt: null,
          deadLetteredAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        enqueued: false,
        skipped: "unconfigured",
      };
    }
    throw err;
  }

  const claim = await storage.claimWebhookDeliveryOut({
    eventId: args.eventId,
    eventType: args.eventType,
    targetUrl,
    payload: args.payload,
  });

  if (claim.created && (args.triggerImmediately ?? true)) {
    // Fire-and-forget. Errors are caught + logged inside `attemptDelivery`
    // and persisted to the row, so we never bubble them up to the
    // inbound HTTP handler.
    void attemptDelivery(claim.row.id).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WebhookDelivery] Immediate attempt threw for id=${claim.row.id}: ${msg}`);
    });
  }

  return { delivery: claim.row, enqueued: claim.created };
}

/**
 * Run one attempt against a delivery row. Updates the row in-place
 * with the attempt outcome. Safe to call concurrently against
 * different ids; concurrent calls against the SAME id may double-post
 * (the unique index protects against double-enqueue, not double-
 * dispatch — Archidoc's idempotency on `webhookEventId` UNIQUE handles
 * the wire-side dedup, so a worst-case race is harmless).
 */
export async function attemptDelivery(deliveryId: number): Promise<WebhookDeliveryOut | undefined> {
  const row = await storage.getWebhookDeliveryOutById(deliveryId);
  if (!row) {
    console.warn(`[WebhookDelivery] attemptDelivery: id=${deliveryId} not found`);
    return undefined;
  }
  if (row.state !== "pending") {
    // Terminal — admin retry path resets to pending before calling us.
    return row;
  }

  const attempt = row.attemptCount + 1;
  const now = new Date();
  let outcome: DeliveryOutcome;
  try {
    outcome = await postWorkAuthorisation({
      payload: row.payload as { eventId: string; eventType: OutboundEventType } & Record<string, unknown>,
      targetUrl: row.targetUrl,
    });
  } catch (err) {
    if (err instanceof ArchidocWebhookConfigError || err instanceof ArchidocWebhookPayloadTooLargeError) {
      // Configuration / oversized payload — both are permanent. Dead-
      // letter immediately so the operator sees it in the admin UI.
      const message = err.message;
      console.error(
        `[WebhookDelivery] Permanent failure id=${deliveryId} eventId=${row.eventId} eventType=${row.eventType}: ${message}`,
      );
      return storage.updateWebhookDeliveryAttempt(deliveryId, {
        state: "dead_lettered",
        attemptCount: attempt,
        lastAttemptAt: now,
        lastErrorBody: message,
        nextAttemptAt: null,
        deadLetteredAt: now,
      });
    }
    // Unknown — treat as transient if we still have attempts left.
    const message = err instanceof Error ? err.message : String(err);
    return finaliseAttempt(row, attempt, now, {
      ok: false,
      retryable: true,
      error: `Unhandled dispatch error: ${message}`,
      networkError: true,
    });
  }

  return finaliseAttempt(row, attempt, now, outcome);
}

async function finaliseAttempt(
  row: WebhookDeliveryOut,
  attempt: number,
  now: Date,
  outcome: DeliveryOutcome,
): Promise<WebhookDeliveryOut | undefined> {
  if (outcome.ok) {
    return storage.updateWebhookDeliveryAttempt(row.id, {
      state: "succeeded",
      attemptCount: attempt,
      lastAttemptAt: now,
      lastErrorBody: outcome.deduplicated ? "deduplicated=true" : null,
      nextAttemptAt: null,
      succeededAt: now,
    });
  }

  const exhausted = attempt >= MAX_ATTEMPTS;
  if (!outcome.retryable || exhausted) {
    return storage.updateWebhookDeliveryAttempt(row.id, {
      state: "dead_lettered",
      attemptCount: attempt,
      lastAttemptAt: now,
      lastErrorBody: outcome.error,
      nextAttemptAt: null,
      deadLetteredAt: now,
    });
  }

  const nextAttemptAt = new Date(
    now.getTime() + computeBackoffMs(attempt, outcome.retryAfterMs),
  );
  return storage.updateWebhookDeliveryAttempt(row.id, {
    state: "pending",
    attemptCount: attempt,
    lastAttemptAt: now,
    lastErrorBody: outcome.error,
    nextAttemptAt,
  });
}

export function computeBackoffMs(attempt: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return retryAfterMs;
  }
  // 1st failure → 1s, 2nd → 4s. (Third attempt would be the dead-letter
  // boundary so the third backoff value is never used.)
  const exp = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, Math.max(0, attempt - 1));
  const jitter = (Math.random() * 2 - 1) * JITTER_PCT * exp;
  return Math.max(0, Math.floor(exp + jitter));
}

/**
 * Pull and dispatch all due-pending rows. Bounded by SWEEPER_BATCH so
 * a backlog can't starve the event loop.
 */
export async function processDuePending(limit: number = SWEEPER_BATCH): Promise<number> {
  const due = await storage.listDueWebhookDeliveries(limit);
  let processed = 0;
  for (const row of due) {
    try {
      await attemptDelivery(row.id);
      processed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WebhookDelivery] Sweeper attempt threw for id=${row.id}: ${msg}`);
    }
  }
  return processed;
}

let sweeperHandle: NodeJS.Timeout | null = null;

/**
 * Idempotent. Subsequent calls are no-ops. Safe to invoke during boot
 * even if the env vars aren't set — `processDuePending` simply finds
 * nothing to do.
 */
export function startWebhookDeliverySweeper(): void {
  if (sweeperHandle) return;
  sweeperHandle = setInterval(() => {
    processDuePending().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WebhookDelivery] Sweeper tick failed: ${msg}`);
    });
  }, SWEEPER_INTERVAL_MS);
  // Don't keep the process alive purely for the sweeper.
  sweeperHandle.unref?.();
  console.log(
    `[WebhookDelivery] Sweeper started (interval=${SWEEPER_INTERVAL_MS}ms, batch=${SWEEPER_BATCH}, maxAttempts=${MAX_ATTEMPTS})`,
  );
}

export function stopWebhookDeliverySweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}
