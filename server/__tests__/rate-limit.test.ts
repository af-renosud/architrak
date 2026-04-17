import { describe, it, expect, vi } from "vitest";
import { rateLimit } from "../middleware/rate-limit";

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

describe("rateLimit middleware", () => {
  it("allows requests under the cap and blocks the next one", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    const next = vi.fn();
    for (let i = 0; i < 3; i++) {
      const ctx = makeReqRes();
      limiter(ctx.req, ctx.res, next);
    }
    expect(next).toHaveBeenCalledTimes(3);

    const blocked = makeReqRes();
    limiter(blocked.req, blocked.res, next);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.payload.message).toMatch(/Too many|rate/i);
    expect(blocked.headers["Retry-After"]).toBeDefined();
  });

  it("uses session userId as key when available", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    const a = makeReqRes(); a.req.session.userId = "alice"; limiter(a.req, a.res, next);
    const b = makeReqRes(); b.req.session.userId = "bob"; limiter(b.req, b.res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const aAgain = makeReqRes(); aAgain.req.session.userId = "alice"; limiter(aAgain.req, aAgain.res, next);
    expect(aAgain.statusCode).toBe(429);
  });
});
