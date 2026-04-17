import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { env } from "../env";

interface LimiterOptions {
  /**
   * Stable identifier for this limiter. Used to namespace keys so different
   * limiters do not share buckets in the shared store, while the same named
   * limiter does share state across replicas.
   */
  name: string;
  windowMs: number;
  max: number;
  keyer?: (req: Request) => string;
  message?: string;
  store?: RateLimitStore;
}

export interface ConsumeResult {
  allowed: boolean;
  tokens: number;
}

export interface RateLimitStore {
  consume(
    key: string,
    max: number,
    refillPerMs: number,
    now: number,
  ): Promise<ConsumeResult>;
}

export function rateLimit(opts: LimiterOptions) {
  const {
    name,
    windowMs,
    max,
    keyer = defaultKeyer,
    message = "Too many requests",
    store = getDefaultStore(),
  } = opts;
  const refillPerMs = max / windowMs;

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const key = `${name}:${keyer(req)}`;
    const now = Date.now();
    Promise.resolve(store.consume(key, max, refillPerMs, now))
      .then((result) => {
        if (result.allowed) return next();
        const retryAfterSec = Math.ceil((1 - result.tokens) / refillPerMs / 1000);
        res.setHeader("Retry-After", String(Math.max(1, retryAfterSec)));
        res.status(429).json({ message });
      })
      .catch((err) => {
        // Fail-open: rate limit storage failures must not take the API down.
        console.error("[rate-limit] store error, allowing request:", err);
        next();
      });
  };
}

function defaultKeyer(req: Request): string {
  const userId = (req as any).session?.userId;
  if (userId) return `u:${userId}`;
  const fwd = req.header("x-forwarded-for");
  const ip = (fwd?.split(",")[0] || req.ip || req.socket.remoteAddress || "anon").trim();
  return `ip:${ip}`;
}

// ---------------------------------------------------------------------------
// In-memory store (single-process; used for local development & tests)
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, Bucket>();
  private cleanupTimer: NodeJS.Timeout;

  constructor(cleanupIntervalMs = 60_000, private maxAgeMs = 5 * 60_000) {
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  async consume(key: string, max: number, refillPerMs: number, now: number): Promise<ConsumeResult> {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: max, updatedAt: now };
      this.buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, now - b.updatedAt);
      b.tokens = Math.min(max, b.tokens + elapsed * refillPerMs);
      b.updatedAt = now;
    }
    if (b.tokens < 1) {
      return { allowed: false, tokens: b.tokens };
    }
    b.tokens -= 1;
    return { allowed: true, tokens: b.tokens };
  }

  private cleanup() {
    const cutoff = Date.now() - this.maxAgeMs;
    Array.from(this.buckets.entries()).forEach(([k, b]) => {
      if (b.updatedAt < cutoff) this.buckets.delete(k);
    });
  }

  stop() {
    clearInterval(this.cleanupTimer);
  }
}

// ---------------------------------------------------------------------------
// Postgres-backed store (shared across replicas)
// ---------------------------------------------------------------------------

export class PostgresRateLimitStore implements RateLimitStore {
  private initPromise: Promise<void> | null = null;

  constructor(private pool: Pool) {}

  private init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS rate_limit_buckets (
            key TEXT PRIMARY KEY,
            tokens DOUBLE PRECISION NOT NULL,
            updated_at BIGINT NOT NULL
          );
        `);
        await this.pool.query(`
          CREATE OR REPLACE FUNCTION rate_limit_consume(
            p_key TEXT,
            p_max DOUBLE PRECISION,
            p_refill DOUBLE PRECISION,
            p_now BIGINT
          ) RETURNS TABLE(allowed BOOLEAN, tokens DOUBLE PRECISION) AS $$
          DECLARE
            cur_tokens DOUBLE PRECISION;
            cur_updated BIGINT;
            new_tokens DOUBLE PRECISION;
          BEGIN
            -- Ensure the row exists before we lock it. If two transactions race
            -- on a brand-new key, only one INSERT wins; the loser blocks until
            -- the winner commits and then sees the freshly inserted row. This
            -- prevents the "first-hit" over-allow where two replicas could
            -- both treat the bucket as empty-and-fresh and both consume.
            INSERT INTO rate_limit_buckets(key, tokens, updated_at)
            VALUES (p_key, p_max, p_now)
            ON CONFLICT (key) DO NOTHING;

            -- Serialize all concurrent consumers of this key on the row lock.
            SELECT t.tokens, t.updated_at INTO cur_tokens, cur_updated
            FROM rate_limit_buckets t WHERE t.key = p_key FOR UPDATE;

            new_tokens := LEAST(
              p_max,
              cur_tokens + GREATEST(0, p_now - cur_updated)::DOUBLE PRECISION * p_refill
            );

            IF new_tokens < 1 THEN
              UPDATE rate_limit_buckets
                SET tokens = new_tokens, updated_at = p_now
                WHERE key = p_key;
              RETURN QUERY SELECT FALSE, new_tokens;
              RETURN;
            END IF;

            new_tokens := new_tokens - 1;
            UPDATE rate_limit_buckets
              SET tokens = new_tokens, updated_at = p_now
              WHERE key = p_key;
            RETURN QUERY SELECT TRUE, new_tokens;
          END;
          $$ LANGUAGE plpgsql;
        `);
      })().catch((err) => {
        // Reset so a later request can retry initialization.
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  async consume(key: string, max: number, refillPerMs: number, now: number): Promise<ConsumeResult> {
    await this.init();
    const { rows } = await this.pool.query<{ allowed: boolean; tokens: number }>(
      `SELECT allowed, tokens FROM rate_limit_consume($1, $2, $3, $4)`,
      [key, max, refillPerMs, now],
    );
    const row = rows[0];
    return { allowed: row.allowed, tokens: Number(row.tokens) };
  }
}

// ---------------------------------------------------------------------------
// Default store selection
// ---------------------------------------------------------------------------

let defaultStore: RateLimitStore | null = null;

export function getDefaultStore(): RateLimitStore {
  if (!defaultStore) {
    defaultStore = createDefaultStore();
  }
  return defaultStore;
}

export function setDefaultStore(store: RateLimitStore | null) {
  defaultStore = store;
}

function createDefaultStore(): RateLimitStore {
  const mode = env.RATE_LIMIT_STORE;
  const useMemory =
    mode === "memory" ||
    (mode === undefined && env.NODE_ENV !== "production");

  if (useMemory) {
    return new MemoryRateLimitStore();
  }

  // Lazily require ./db so this module stays usable in unit tests that don't
  // provision DATABASE_URL.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pool } = require("../db") as { pool: Pool };
  return new PostgresRateLimitStore(pool);
}
