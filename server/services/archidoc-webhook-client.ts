/**
 * Archidoc outbound webhook client (AT5, contract §5.3 + §3.9).
 *
 * One-way Architrak → Archidoc delivery surface for the
 * /api/integrations/architrak/work-authorisations endpoint. Both
 * `eventType` variants (work_authorised, signed_pdf_retention_breach)
 * target the SAME endpoint URL — Archidoc routes at the handler on the
 * `eventType` discriminator.
 *
 * AT5 owns three hard rules:
 *   1. Hard-fail when ARCHITRAK_WEBHOOK_SECRET is unset (never fall
 *      through to unsigned traffic). Throws ArchidocWebhookConfigError.
 *   2. 1 MiB pre-send payload cap (symmetric with Archidoc's inbound
 *      413 per contract §3.9). Throws ArchidocWebhookPayloadTooLargeError.
 *   3. Always emit the explicit `eventType` field (G8) — never rely on
 *      Archidoc's "absent → work_authorised" backward-compat default.
 *      The retry/DLQ orchestrator is responsible for not stripping it
 *      from the payload between the enqueue and the dispatch.
 *
 * HMAC v2 wire spec (contract §3.9.1):
 *   X-Architrak-Timestamp: <unix-millis>
 *   X-Architrak-Signature: sha256=<hex of HMAC-SHA256(secret, `${ts}.${rawBody}`)>
 *
 * Retry policy lives in webhook-delivery.ts — this module is one
 * single-attempt POST. Caller maps the `outcome.retryable` field to
 * "schedule another attempt vs dead-letter immediately".
 */

import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../env";

export class ArchidocWebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchidocWebhookConfigError";
  }
}

export class ArchidocWebhookPayloadTooLargeError extends Error {
  constructor(public readonly byteLength: number, public readonly capBytes: number) {
    super(`Outbound webhook payload too large: ${byteLength} bytes (cap ${capBytes})`);
    this.name = "ArchidocWebhookPayloadTooLargeError";
  }
}

export const PAYLOAD_CAP_BYTES = 1024 * 1024; // 1 MiB per contract §3.9
const PER_ATTEMPT_TIMEOUT_MS = 10_000;

export type OutboundEventType = "work_authorised" | "signed_pdf_retention_breach";

export type DeliveryOutcome =
  | { ok: true; httpStatus: number; deduplicated: boolean }
  | {
      ok: false;
      retryable: boolean;
      httpStatus?: number;
      error: string;
      retryAfterMs?: number;
      networkError?: boolean;
    };

/**
 * Resolves the destination URL. Allows the explicit
 * ARCHIDOC_WORK_AUTH_URL override (test envs); otherwise concatenates
 * the canonical path onto ARCHIDOC_BASE_URL.
 */
export function getWorkAuthorisationUrl(): string {
  if (env.ARCHIDOC_WORK_AUTH_URL) {
    return env.ARCHIDOC_WORK_AUTH_URL;
  }
  if (!env.ARCHIDOC_BASE_URL) {
    throw new ArchidocWebhookConfigError(
      "ARCHIDOC_BASE_URL is not configured (cannot derive work-authorisations URL)",
    );
  }
  const base = env.ARCHIDOC_BASE_URL.replace(/\/+$/, "");
  return `${base}/api/integrations/architrak/work-authorisations`;
}

/**
 * Pulls the secret with a hard-fail. The retry/DLQ orchestrator MUST
 * call this before queuing — never fall through to unsigned traffic.
 */
export function requireArchitrakWebhookSecret(): string {
  const secret = env.ARCHITRAK_WEBHOOK_SECRET;
  if (!secret) {
    throw new ArchidocWebhookConfigError(
      "ARCHITRAK_WEBHOOK_SECRET is not configured — refusing to send unsigned webhook traffic",
    );
  }
  return secret;
}

/**
 * Returns true when the outbound surface is fully configured (secret +
 * a base URL). Used by tests and self-checks; NOT used by AT4 to gate
 * enqueue — see `isOutboundOperational` for that decision.
 */
export function isOutboundDeliveryConfigured(): boolean {
  return Boolean(env.ARCHITRAK_WEBHOOK_SECRET && (env.ARCHIDOC_WORK_AUTH_URL || env.ARCHIDOC_BASE_URL));
}

/**
 * Returns true when the env is "operational" — i.e. an Archidoc target
 * URL is set, so this deployment is EXPECTED to dispatch outbound
 * webhooks. The secret may still be unset; in that case enqueue MUST
 * proceed so the missing-secret failure surfaces in the admin DLQ +
 * operator-alerts channel rather than being silently swallowed.
 *
 * AT4's inbound handlers consult this to differentiate:
 *   - operational + secret missing  → enqueue (will hard-fail+ops-alert)
 *   - operational + secret present  → enqueue (normal dispatch)
 *   - not operational               → soft-skip (true dev environment)
 */
export function isOutboundOperational(): boolean {
  return Boolean(env.ARCHIDOC_WORK_AUTH_URL || env.ARCHIDOC_BASE_URL);
}

/**
 * HMAC v2 signature header value. Exposed for golden tests; receivers
 * compute the same `sha256(${ts}.${rawBody})` per contract §3.9.1.
 */
export function computeSignatureHex(secret: string, timestampMs: number, rawBody: string | Buffer): string {
  const h = createHmac("sha256", secret);
  h.update(`${timestampMs}.`);
  h.update(rawBody);
  return h.digest("hex");
}

/**
 * Constant-time hex-string comparison helper. Handy for tests that
 * round-trip the signature; not used by the dispatch path itself
 * (Archidoc verifies — Architrak only signs).
 */
export function signaturesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Serialises the payload deterministically (JSON.stringify with no
 * indentation — byte-stable across runs) and applies the 1 MiB cap.
 * Returns the raw body the HMAC will sign and the dispatcher will POST.
 */
export function serialisePayload(payload: unknown): string {
  const body = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(body, "utf8");
  if (byteLength > PAYLOAD_CAP_BYTES) {
    throw new ArchidocWebhookPayloadTooLargeError(byteLength, PAYLOAD_CAP_BYTES);
  }
  return body;
}

interface PostArgs {
  payload: { eventId: string; eventType: OutboundEventType } & Record<string, unknown>;
  /**
   * `Date.now()` injection seam for tests. Production callers pass
   * nothing; tests pin the timestamp so the HMAC is reproducible.
   */
  nowMs?: number;
  /**
   * URL override seam for tests / per-tenant scoping. Production
   * callers omit this and let `getWorkAuthorisationUrl()` resolve.
   */
  targetUrl?: string;
}

/**
 * Single-attempt POST. The retry/DLQ orchestrator wraps this and decides
 * whether `outcome.retryable === true` warrants scheduling another
 * attempt vs dead-lettering. Never throws on HTTP errors — only on the
 * three "we cannot dispatch at all" config errors above.
 */
export async function postWorkAuthorisation(args: PostArgs): Promise<DeliveryOutcome> {
  // G8: explicit eventType assertion — the ENQUEUE path already builds
  // the payload with this field set, but we re-assert here so a future
  // refactor that strips it doesn't silently rely on Archidoc's
  // backward-compat default.
  if (args.payload.eventType !== "work_authorised" && args.payload.eventType !== "signed_pdf_retention_breach") {
    throw new ArchidocWebhookConfigError(
      `Outbound payload missing or invalid eventType: ${String(args.payload.eventType)}`,
    );
  }

  const secret = requireArchitrakWebhookSecret();
  const url = args.targetUrl ?? getWorkAuthorisationUrl();
  const rawBody = serialisePayload(args.payload);
  const ts = args.nowMs ?? Date.now();
  const signature = computeSignatureHex(secret, ts, rawBody);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Architrak-Timestamp": String(ts),
        "X-Architrak-Signature": `sha256=${signature}`,
      },
      body: rawBody,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      retryable: true,
      networkError: true,
      error: `Network error: ${message}`,
    };
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => "");
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
  }

  if (res.status >= 200 && res.status < 300) {
    // Treat 200 + {deduplicated:true} as success per Archidoc's
    // idempotency contract — duplicate deliveries (retry burst) collapse
    // to 200 there, and we should treat them as terminal-success here.
    const deduplicated = Boolean(
      parsed && typeof parsed === "object" && (parsed as { deduplicated?: unknown }).deduplicated === true,
    );
    return { ok: true, httpStatus: res.status, deduplicated };
  }

  if (res.status === 429) {
    const ra = res.headers.get("Retry-After");
    const retryAfterMs = ra ? Math.max(0, Number(ra)) * 1000 : undefined;
    return {
      ok: false,
      retryable: true,
      httpStatus: res.status,
      error: `Archidoc 429 rate-limited`,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
    };
  }

  // 4xx (non-429) is a payload / signature / contract error — Archidoc
  // will return the same answer next time. Per §1.4 these dead-letter
  // immediately rather than burning retry attempts.
  if (res.status >= 400 && res.status < 500) {
    return {
      ok: false,
      retryable: false,
      httpStatus: res.status,
      error: `Archidoc ${res.status}: ${truncate(text)}`,
    };
  }

  // 5xx → retryable per §1.4.
  return {
    ok: false,
    retryable: true,
    httpStatus: res.status,
    error: `Archidoc ${res.status}: ${truncate(text)}`,
  };
}

function truncate(s: string, n: number = 1024): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…[truncated ${s.length - n} chars]`;
}
