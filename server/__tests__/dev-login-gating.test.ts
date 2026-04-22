import { describe, it, expect, vi, afterEach } from "vitest";
import express, { type Express } from "express";
import http from "http";
import type { AddressInfo } from "net";

function fakeSessionMiddleware() {
  return (req: any, _res: any, next: any) => {
    req.session = {
      userId: undefined as number | undefined,
      regenerate(cb: (err?: any) => void) {
        cb();
      },
      save(cb: (err?: any) => void) {
        cb();
      },
      destroy(cb: (err?: any) => void) {
        cb();
      },
    };
    next();
  };
}

async function buildApp({
  nodeEnv,
  enableDevLogin,
}: {
  nodeEnv: "development" | "production" | "test";
  enableDevLogin: boolean;
}): Promise<{ app: Express; warnSpy: ReturnType<typeof vi.spyOn>; upsertUser: ReturnType<typeof vi.fn> }> {
  vi.resetModules();

  vi.doMock("../env", () => ({
    env: {
      NODE_ENV: nodeEnv,
      ENABLE_DEV_LOGIN_FOR_E2E: enableDevLogin,
    },
  }));

  const upsertUser = vi.fn().mockResolvedValue({
    id: 7,
    email: "anything@whatever.test",
    firstName: "Dev",
    lastName: "User",
    profileImageUrl: null,
  });
  vi.doMock("../storage", () => ({
    storage: { upsertUser, getUser: vi.fn() },
  }));

  vi.doMock("../auth/google-oauth", () => ({
    getAuthUrl: vi.fn(),
    exchangeCodeForUser: vi.fn(),
    DomainRestrictionError: class DomainRestrictionError extends Error {},
  }));

  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  const { registerAuthRoutes } = await import("../auth/routes");

  const app = express();
  app.use(express.json());
  app.use(fakeSessionMiddleware());
  registerAuthRoutes(app);

  return { app, warnSpy, upsertUser };
}

async function postJson(app: Express, path: string, body: unknown) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("dev-login route gating", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns 404 when ENABLE_DEV_LOGIN_FOR_E2E is off (development)", async () => {
    const { app, warnSpy } = await buildApp({ nodeEnv: "development", enableDevLogin: false });
    const r = await postJson(app, "/api/auth/dev-login", { email: "anyone@example.com" });
    expect(r.status).toBe(404);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("DEV LOGIN ENABLED"),
    );
  });

  it("returns 404 when NODE_ENV=production even if ENABLE_DEV_LOGIN_FOR_E2E is on", async () => {
    const { app, warnSpy } = await buildApp({ nodeEnv: "production", enableDevLogin: true });
    const r = await postJson(app, "/api/auth/dev-login", { email: "anyone@example.com" });
    expect(r.status).toBe(404);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("DEV LOGIN ENABLED"),
    );
  });

  it("returns 200 and creates a session when both gates are open", async () => {
    const { app, warnSpy, upsertUser } = await buildApp({
      nodeEnv: "development",
      enableDevLogin: true,
    });
    const r = await postJson(app, "/api/auth/dev-login", { email: "qa@local.test" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ id: 7 });
    expect(upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "qa@local.test", googleId: "dev:qa@local.test" }),
    );
    const warnedAtRegistration = warnSpy.mock.calls.some((args) =>
      typeof args[0] === "string" && args[0].includes("DEV LOGIN ENABLED"),
    );
    expect(warnedAtRegistration).toBe(true);
  });

  it("rejects requests with no email when enabled", async () => {
    const { app } = await buildApp({ nodeEnv: "development", enableDevLogin: true });
    const r = await postJson(app, "/api/auth/dev-login", {});
    expect(r.status).toBe(400);
  });
});
