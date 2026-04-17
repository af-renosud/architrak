import { describe, it, expect, vi } from "vitest";
import { rateLimit, MemoryRateLimitStore, PostgresRateLimitStore, type RateLimitStore } from "../middleware/rate-limit";

function makeReqRes() {
  const headers: Record<string, string> = {};
  const req: any = { ip: "1.2.3.4", header: () => undefined, socket: { remoteAddress: "1.2.3.4" }, session: {} };
  let statusCode = 200;
  let payload: any = undefined;
  const res: any = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status: (n: number) => { statusCode = n; return res; },
    json: (b: any) => { payload = b; return res; },
  };
  return { req, res, get statusCode() { return statusCode; }, get payload() { return payload; }, headers };
}

function flush() {
  // Allow the queued promise in the middleware to settle.
  return new Promise((resolve) => setImmediate(resolve));
}

describe("rateLimit middleware", () => {
  it("allows requests under the cap and blocks the next one", async () => {
    const store = new MemoryRateLimitStore();
    const limiter = rateLimit({ name: "t1", windowMs: 60_000, max: 3, store });
    const next = vi.fn();
    for (let i = 0; i < 3; i++) {
      const ctx = makeReqRes();
      limiter(ctx.req, ctx.res, next);
      await flush();
    }
    expect(next).toHaveBeenCalledTimes(3);

    const blocked = makeReqRes();
    limiter(blocked.req, blocked.res, next);
    await flush();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.payload.message).toMatch(/Too many|rate/i);
    expect(blocked.headers["Retry-After"]).toBeDefined();
    store.stop();
  });

  it("uses session userId as key when available", async () => {
    const store = new MemoryRateLimitStore();
    const limiter = rateLimit({ name: "t2", windowMs: 60_000, max: 1, store });
    const next = vi.fn();

    const a = makeReqRes(); a.req.session.userId = "alice"; limiter(a.req, a.res, next); await flush();
    const b = makeReqRes(); b.req.session.userId = "bob"; limiter(b.req, b.res, next); await flush();

    expect(next).toHaveBeenCalledTimes(2);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const aAgain = makeReqRes(); aAgain.req.session.userId = "alice"; limiter(aAgain.req, aAgain.res, next);
    await flush();
    expect(aAgain.statusCode).toBe(429);
    store.stop();
  });

  it("namespaces keys by limiter name so distinct limiters do not share buckets", async () => {
    const store = new MemoryRateLimitStore();
    const limiterA = rateLimit({ name: "limA", windowMs: 60_000, max: 1, store });
    const limiterB = rateLimit({ name: "limB", windowMs: 60_000, max: 1, store });
    const next = vi.fn();

    const a = makeReqRes(); limiterA(a.req, a.res, next); await flush();
    const b = makeReqRes(); limiterB(b.req, b.res, next); await flush();
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(2);
    store.stop();
  });

  it("shares state across limiter instances with the same name (cluster simulation)", async () => {
    // Two rateLimit() instances using the same shared store and same name
    // model two replicas of the same logical limiter.
    const sharedStore = new MemoryRateLimitStore();
    const replicaA = rateLimit({ name: "shared", windowMs: 60_000, max: 2, store: sharedStore });
    const replicaB = rateLimit({ name: "shared", windowMs: 60_000, max: 2, store: sharedStore });
    const next = vi.fn();

    const r1 = makeReqRes(); replicaA(r1.req, r1.res, next); await flush();
    const r2 = makeReqRes(); replicaB(r2.req, r2.res, next); await flush();
    const r3 = makeReqRes(); replicaA(r3.req, r3.res, next); await flush();

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
    sharedStore.stop();
  });

  it("fails open if the store throws", async () => {
    const brokenStore: RateLimitStore = {
      consume: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const limiter = rateLimit({ name: "t3", windowMs: 60_000, max: 1, store: brokenStore });
    const next = vi.fn();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ctx = makeReqRes();
    limiter(ctx.req, ctx.res, next);
    await flush();
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.statusCode).toBe(200);
    errSpy.mockRestore();
  });

  it("exports a PostgresRateLimitStore class", () => {
    // Smoke: ensure the shared-store class is wired up and exported.
    expect(typeof PostgresRateLimitStore).toBe("function");
  });
});
