import type { Request, Response, NextFunction } from "express";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface LimiterOptions {
  windowMs: number;
  max: number;
  keyer?: (req: Request) => string;
  message?: string;
}

export function rateLimit(opts: LimiterOptions) {
  const { windowMs, max, keyer = defaultKeyer, message = "Too many requests" } = opts;
  const buckets = new Map<string, Bucket>();
  const refillPerMs = max / windowMs;

  // Periodic cleanup so buckets do not grow unbounded.
  setInterval(() => {
    const cutoff = Date.now() - windowMs * 4;
    Array.from(buckets.entries()).forEach(([k, b]) => {
      if (b.updatedAt < cutoff) buckets.delete(k);
    });
  }, Math.max(windowMs, 60_000)).unref?.();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const key = keyer(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: max, updatedAt: now };
      buckets.set(key, b);
    } else {
      const elapsed = now - b.updatedAt;
      b.tokens = Math.min(max, b.tokens + elapsed * refillPerMs);
      b.updatedAt = now;
    }
    if (b.tokens < 1) {
      const retryAfterSec = Math.ceil((1 - b.tokens) / refillPerMs / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfterSec)));
      return res.status(429).json({ message });
    }
    b.tokens -= 1;
    next();
  };
}

function defaultKeyer(req: Request): string {
  const userId = (req as any).session?.userId;
  if (userId) return `u:${userId}`;
  const fwd = req.header("x-forwarded-for");
  const ip = (fwd?.split(",")[0] || req.ip || req.socket.remoteAddress || "anon").trim();
  return `ip:${ip}`;
}
