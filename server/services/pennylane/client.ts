/**
 * Pennylane external-API HTTP client (Task #214).
 *
 * Thin wrapper around `fetch` that centralises:
 *   - bearer-token auth (PENNYLANE_API_KEY)
 *   - base URL resolution (PENNYLANE_BASE_URL, defaults to v2)
 *   - 429 / 5xx retry with exponential backoff
 *   - cursor-based pagination helper (the v2 API mandates cursors —
 *     no offset/page params)
 *   - structured PennylaneApiError so callers can branch on transient
 *     vs permanent without parsing strings.
 *
 * Feature gating lives here too: `isPennylanePushEnabled()` and
 * `isProjectWhitelisted(projectId)` are the single source of truth.
 * Callers never read env directly — they ask this module.
 */

import { env } from "../../env";

export const MAX_RETRY_ATTEMPTS = 4; // initial + 3 retries
const BASE_RETRY_DELAY_MS = 500;

/**
 * Distinguishes transient (retry-worthy) failures from permanent
 * ones so the push-queue worker can decide between backoff and
 * dead-letter without re-parsing the error message.
 */
export class PennylaneApiError extends Error {
  readonly status: number;
  readonly transient: boolean;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Pennylane API error ${status}: ${body.slice(0, 300)}`);
    this.name = "PennylaneApiError";
    this.status = status;
    this.body = body;
    // 429 + 5xx are transient. Network failures (status === 0) too.
    this.transient = status === 0 || status === 429 || status >= 500;
  }
}

export function isPennylaneConfigured(): boolean {
  return Boolean(env.PENNYLANE_API_KEY);
}

export function isPennylanePushEnabled(): boolean {
  return env.PENNYLANE_PUSH_ENABLED && isPennylaneConfigured();
}

export function isPennylaneDryRun(): boolean {
  return env.PENNYLANE_DRY_RUN;
}

/**
 * Project-whitelist semantics (matches the comment in env.ts):
 *   - env var ABSENT (undefined)  → all projects allowed
 *   - env var SET to ""           → no projects allowed (kill-switch)
 *   - env var SET to "1,5,9"      → only those ids allowed
 */
export function isProjectWhitelisted(projectId: number): boolean {
  const raw = env.PENNYLANE_PROJECT_WHITELIST;
  if (raw === undefined) return true;
  const allowed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return allowed.includes(projectId);
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Override the retry cap (default MAX_RETRY_ATTEMPTS). */
  maxAttempts?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const base = env.PENNYLANE_BASE_URL.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${cleanPath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Low-level request. Throws PennylaneApiError on non-2xx. Retries
 * transient failures (429 + 5xx + network) with exponential backoff
 * up to `maxAttempts` total tries. Honours the `Retry-After` header
 * on 429 when present.
 */
export async function pennylaneRequest<T = unknown>(
  opts: RequestOptions,
): Promise<T> {
  if (!isPennylaneConfigured()) {
    throw new Error("Pennylane API key not configured");
  }
  const url = buildUrl(opts.path, opts.query);
  const maxAttempts = opts.maxAttempts ?? MAX_RETRY_ATTEMPTS;

  let lastErr: PennylaneApiError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method,
        headers: {
          Authorization: `Bearer ${env.PENNYLANE_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      // Network-level failure (DNS, TLS, refused, etc.) — treat as
      // transient status=0.
      const message = err instanceof Error ? err.message : String(err);
      lastErr = new PennylaneApiError(0, message, `Pennylane network error: ${message}`);
      if (attempt < maxAttempts) {
        await sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastErr;
    }

    if (res.ok) {
      // 204 No Content → return empty object cast to T (callers that
      // care will provide a void/never T).
      if (res.status === 204) return {} as T;
      // Some Pennylane endpoints return text/plain for errors but
      // JSON for success — branch on content-type defensively.
      const text = await res.text();
      if (text.length === 0) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }

    const body = await res.text();
    lastErr = new PennylaneApiError(res.status, body);
    if (!lastErr.transient || attempt === maxAttempts) {
      throw lastErr;
    }
    // 429 may carry Retry-After (seconds OR HTTP-date). Prefer that
    // when sensible, otherwise exponential backoff.
    let waitMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
    const retryAfter = res.headers.get("Retry-After");
    if (retryAfter) {
      const sec = Number(retryAfter);
      if (Number.isFinite(sec) && sec >= 0 && sec <= 60) {
        waitMs = Math.max(waitMs, sec * 1000);
      }
    }
    await sleep(waitMs);
  }
  // Unreachable — the loop either returns or throws.
  throw lastErr ?? new PennylaneApiError(0, "exhausted retries");
}

/**
 * Cursor-paginated list helper. The v2 API returns:
 *   { items: T[], next_cursor: string | null }
 * (or sometimes { results: T[], next_cursor: ... } depending on the
 * resource). This helper hides the shape difference and yields one
 * page at a time so callers can stream without buffering everything.
 */
export interface PennylanePage<T> {
  items: T[];
  nextCursor: string | null;
}

interface RawListPayload<T> {
  items?: T[];
  results?: T[];
  data?: T[];
  next_cursor?: string | null;
  cursor?: string | null;
}

export async function fetchPage<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  cursor: string | null = null,
): Promise<PennylanePage<T>> {
  const merged: Record<string, string | number | undefined> = { ...query };
  if (cursor) merged.cursor = cursor;
  const raw = await pennylaneRequest<RawListPayload<T>>({
    method: "GET",
    path,
    query: merged,
  });
  const items = raw.items ?? raw.results ?? raw.data ?? [];
  const nextCursor = raw.next_cursor ?? raw.cursor ?? null;
  return { items, nextCursor };
}

/**
 * Convenience: iterate every page of a cursor-paginated list. Safe
 * for use as `for await` — caller decides when to stop (e.g. by
 * `break`ing once a row's external_id matches).
 */
export async function* iteratePages<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
): AsyncGenerator<T[], void, void> {
  let cursor: string | null = null;
  // Hard cap so a server bug returning a non-terminating cursor
  // can't pin the worker forever. 200 pages × 50 items/page = 10k.
  const MAX_PAGES = 200;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: PennylanePage<T> = await fetchPage<T>(path, query, cursor);
    yield page.items;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

/**
 * Health check — calls the `/me` (or equivalent) endpoint so the
 * admin DLQ surface can prove credentials + scopes are alive.
 * Returns the raw JSON; the admin route exposes it verbatim.
 */
export async function pingPennylane(): Promise<unknown> {
  return pennylaneRequest({ method: "GET", path: "/me" });
}
