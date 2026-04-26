/**
 * Archisign outbound client (AT4, contract §3.5).
 *
 * Three named exports — `createEnvelope`, `sendEnvelope`, `getSignedPdfUrl`.
 * Named for AT5 extension (`/signed-pdf-url` re-mint flow).
 *
 * Auth model: `X-API-KEY` header (NOT Bearer — Archisign convention per §3.6).
 * The env var `ARCHISIGN_API_KEY` is a CSV; we use the FIRST entry (rotation
 * windows are out of scope for AT4 — operator rotates by reordering CSV).
 *
 * Retry policy (§1.4): 3 attempts; 1s/3s/exhausted; per-attempt 10s timeout;
 * retry on 5xx + network errors + 429 (Retry-After honoured); 4xx fails fast
 * and the caller is expected to surface the error to the architect.
 *
 * Wire response: /create returns { envelopeId, accessUrl, accessToken,
 * otpDestination, expiresAt }. accessUrl is the ONLY persisted URL —
 * /send's response is not re-read for URL data per G3 / §3.5.4.
 */

import { env } from "../env";

export class ArchisignError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly responseBody?: unknown,
    public readonly isTransient: boolean = false,
  ) {
    super(message);
    this.name = "ArchisignError";
  }
}

interface CreateEnvelopePayload {
  // Architrak's stable correlation id for this envelope (devis id).
  externalRef: string;
  // Signer details — single signer per devis (architect's client).
  signer: {
    fullName: string;
    email: string;
    phone?: string;
  };
  // PDF the signer will sign — Architrak supplies a short-TTL fetch URL
  // (§G2: ≥5min floor enforced here).
  pdfFetchUrl: string;
  // Webhook target — must be Architrak's canonical prod URL (G9 immutable).
  webhookUrl: string;
  // Optional override of the 30-day default (§G5: ≥ now()+1min).
  expiresAt?: Date;
  // Free-form subject/body for the signer-facing email.
  subject?: string;
  body?: string;
}

export interface CreateEnvelopeResponse {
  envelopeId: string;
  accessUrl: string;
  accessToken: string;
  otpDestination: string;
  expiresAt: string; // ISO 8601 — Archisign's authoritative value (echoed for storage)
}

export interface SendEnvelopeResponse {
  envelopeId: string;
  status: "sent" | "viewed" | "queried";
}

export interface SignedPdfUrlResponse {
  url: string;
  expiresAt: string;
}

interface RetentionBreachBody {
  event: "envelope.retention_breach";
  envelopeId: string;
  originalSignedAt: string;
  detectedAt: string;
  incidentRef: string;
  remediationContact: string;
}

export class ArchisignRetentionBreachError extends ArchisignError {
  constructor(public readonly breach: RetentionBreachBody) {
    super("Signed PDF retention breach (410 Gone)", 410, breach, false);
    this.name = "ArchisignRetentionBreachError";
  }
}

const PER_ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 3_000];
const MIN_PDF_FETCH_URL_TTL_MS = 5 * 60 * 1000; // §G2
const MIN_EXPIRES_AT_MS = 60 * 1000; // §G5
const DEFAULT_EXPIRES_AT_MS = 30 * 24 * 60 * 60 * 1000;

function getApiKey(): string {
  const csv = env.ARCHISIGN_API_KEY;
  if (!csv) {
    throw new ArchisignError("ARCHISIGN_API_KEY is not configured", 503, undefined, true);
  }
  const first = csv.split(",").map((s) => s.trim()).find((s) => s.length > 0);
  if (!first) {
    throw new ArchisignError("ARCHISIGN_API_KEY is empty", 503, undefined, true);
  }
  return first;
}

function getBaseUrl(): string {
  const base = env.ARCHISIGN_BASE_URL;
  if (!base) {
    throw new ArchisignError("ARCHISIGN_BASE_URL is not configured", 503, undefined, true);
  }
  return base.replace(/\/+$/, "");
}

async function archisignFetch<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const apiKey = getApiKey();

  let attempt = 0;
  let lastErr: unknown;
  // 3 attempts total: initial + 2 retries.
  while (attempt < RETRY_DELAYS_MS.length + 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      // 410 with retention_breach body — special-case for /signed-pdf-url
      // per §3.8. Caller distinguishes via instanceof check.
      if (res.status === 410) {
        const text = await res.text();
        let parsed: unknown = undefined;
        try { parsed = JSON.parse(text); } catch { /* non-JSON 410 */ }
        const breach = parsed as RetentionBreachBody | undefined;
        if (breach && breach.event === "envelope.retention_breach") {
          throw new ArchisignRetentionBreachError(breach);
        }
        throw new ArchisignError(`Archisign 410: ${text || res.statusText}`, 410, parsed, false);
      }

      if (res.status >= 200 && res.status < 300) {
        // 204 / empty body — return empty object (callers cast).
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }

      // 429: honour Retry-After if present, then retry.
      if (res.status === 429) {
        const ra = res.headers.get("Retry-After");
        const raMs = ra ? Number(ra) * 1000 : RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        lastErr = new ArchisignError(`Archisign 429 rate-limited (Retry-After=${ra ?? "n/a"})`, 429, undefined, true);
        attempt += 1;
        if (attempt >= RETRY_DELAYS_MS.length + 1) break;
        await new Promise((r) => setTimeout(r, Number.isFinite(raMs) && raMs > 0 ? raMs : 1_000));
        continue;
      }

      const text = await res.text();
      let parsedErr: unknown = undefined;
      try { parsedErr = JSON.parse(text); } catch { /* non-JSON err */ }
      const isTransient = res.status >= 500;
      if (isTransient && attempt < RETRY_DELAYS_MS.length) {
        lastErr = new ArchisignError(`Archisign ${res.status}: ${text || res.statusText}`, res.status, parsedErr, true);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        attempt += 1;
        continue;
      }
      // 4xx (non-429) fails fast. Final 5xx after retries also throws.
      throw new ArchisignError(`Archisign ${res.status}: ${text || res.statusText}`, res.status, parsedErr, isTransient);
    } catch (err) {
      clearTimeout(timer);
      // Already-classified ArchisignError: re-throw (do not wrap-and-retry).
      if (err instanceof ArchisignError) {
        if (err.isTransient && attempt < RETRY_DELAYS_MS.length) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          attempt += 1;
          continue;
        }
        throw err;
      }
      // Network error or AbortError — both retryable per §1.4.
      lastErr = err;
      attempt += 1;
      if (attempt >= RETRY_DELAYS_MS.length + 1) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
  }
  if (lastErr instanceof Error) {
    throw new ArchisignError(`Archisign network error after retries: ${lastErr.message}`, 0, undefined, true);
  }
  throw new ArchisignError("Archisign network error after retries", 0, undefined, true);
}

/**
 * POST /api/v1/envelopes/create — two-step envelope creation, step 1.
 *
 * Validates G2 (pdfFetchUrl ≥ 5min TTL not enforceable here — caller's
 * responsibility, as we don't see the URL's expiry) and G5 (expiresAt
 * ≥ now() + 1min when explicitly provided; default is now() + 30 days).
 *
 * Returns the FOUR persistable fields per §3.5.1. accessUrl is the ONLY
 * persisted URL (G3 / §3.5.4) — never overwrite it from /send's response.
 */
export async function createEnvelope(payload: CreateEnvelopePayload): Promise<CreateEnvelopeResponse> {
  const expiresAt = payload.expiresAt ?? new Date(Date.now() + DEFAULT_EXPIRES_AT_MS);
  if (expiresAt.getTime() < Date.now() + MIN_EXPIRES_AT_MS) {
    // §G5: floor of now()+1min. Caller bug — fail fast, do not call out.
    throw new ArchisignError(
      `expiresAt floor violation: must be >= now()+1min (got ${expiresAt.toISOString()})`,
      400,
      undefined,
      false,
    );
  }
  const wirePayload = {
    externalRef: payload.externalRef,
    signer: payload.signer,
    pdfFetchUrl: payload.pdfFetchUrl,
    webhookUrl: payload.webhookUrl,
    expiresAt: expiresAt.toISOString(),
    subject: payload.subject,
    body: payload.body,
  };
  return archisignFetch<CreateEnvelopeResponse>("POST", "/api/v1/envelopes/create", wirePayload);
}

/**
 * POST /api/v1/envelopes/:id/send — two-step envelope creation, step 2.
 *
 * Idempotent against `sent`/`viewed`/`queried` (§S9: returns 200 on
 * re-send); 409 only on terminal states (signed/declined/expired).
 *
 * AT4 explicitly does NOT consume any URL fields from this response —
 * the create-time accessUrl is the only persisted URL. Returning the
 * status enum is informational only (matched against §3.1 emission).
 */
export async function sendEnvelope(envelopeId: string): Promise<SendEnvelopeResponse> {
  return archisignFetch<SendEnvelopeResponse>("POST", `/api/v1/envelopes/${encodeURIComponent(envelopeId)}/send`);
}

/**
 * GET /api/v1/envelopes/:id/signed-pdf-url — re-mint the signed-PDF URL
 * after the snapshot's TTL (15 min default per §3.5.3) has elapsed.
 *
 * On 410 Gone with `envelope.retention_breach` body, throws
 * `ArchisignRetentionBreachError` so AT5 can route the breach to the
 * downstream re-notification path. Other 410s throw plain `ArchisignError`.
 *
 * Used by AT5 (out of scope for AT4 itself — exported for the next task).
 */
export async function getSignedPdfUrl(envelopeId: string): Promise<SignedPdfUrlResponse> {
  return archisignFetch<SignedPdfUrlResponse>(
    "GET",
    `/api/v1/envelopes/${encodeURIComponent(envelopeId)}/signed-pdf-url`,
  );
}

/**
 * Convenience guard for the pdfFetchUrl TTL invariant (§G2). Callers that
 * mint short-lived signed URLs for the PDF MUST call this BEFORE passing
 * the URL into `createEnvelope` so we never hand Archisign a URL that
 * expires before the signer can fetch it.
 */
export function assertPdfFetchUrlTtl(expiresAt: Date | undefined): void {
  if (!expiresAt) return; // Caller has no expiry concept — trust them.
  if (expiresAt.getTime() - Date.now() < MIN_PDF_FETCH_URL_TTL_MS) {
    throw new ArchisignError(
      `pdfFetchUrl TTL must be >= 5min from now (got ${expiresAt.toISOString()})`,
      400,
      undefined,
      false,
    );
  }
}
