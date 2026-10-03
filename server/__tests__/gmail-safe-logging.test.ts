import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { safeErrorDiagnostic } from "../safe-error";

const mocks = vi.hoisted(() => ({
  updateTokens: vi.fn(),
  exchange: vi.fn(),
  upsertUser: vi.fn(async () => ({ id: 42 })),
  clients: [] as any[],
}));
vi.mock("../env", () => ({
  env: { GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-secret", NODE_ENV: "production" },
}));
vi.mock("../storage", () => ({
  storage: { updateUserGmailTokens: mocks.updateTokens, upsertUser: mocks.upsertUser },
}));
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class extends EventEmitter {
        constructor() { super(); mocks.clients.push(this); }
        setCredentials = vi.fn();
      },
    },
    gmail: vi.fn(() => ({})),
  },
}));
vi.mock("../auth/google-oauth", () => ({
  exchangeCodeForUser: mocks.exchange,
  getAuthUrl: vi.fn(),
  DomainRestrictionError: class extends Error {},
}));

import { getGmailClientForUser } from "../gmail/user-client";
import { registerAuthRoutes } from "../auth/routes";
import { errorHandler } from "../middleware/error-handler";

// Entirely synthetic values, not derived from any environment or incident.
const secrets = [
  "synthetic-access-value-DO-NOT-LOG",
  "synthetic-refresh-value-DO-NOT-LOG",
  "postgresql://synthetic:synthetic-password@invalid.example/db",
  "synthetic-query-parameter-DO-NOT-LOG",
  "synthetic-oauth-code-DO-NOT-LOG",
];
function sensitiveError() {
  const payload = secrets.join(" ");
  const cause = Object.assign(new Error(payload), { code: "23505", detail: payload });
  const error = Object.assign(new Error(`Failed query: ${payload}`), {
    name: payload, stack: payload, cause,
    query: payload, params: secrets,
    config: { url: payload, headers: { Authorization: payload }, data: payload },
    response: { data: payload },
    toJSON: () => ({ secret: payload }),
  });
  return error;
}
function assertLogsSafe(spy: ReturnType<typeof vi.spyOn>) {
  // inspect captures non-enumerable Error.message/stack just as console does.
  const output = inspect(spy.mock.calls, { depth: null });
  for (const secret of secrets) expect(output).not.toContain(secret);
  expect(output).not.toContain("Failed query");
  expect(output).toContain("database_unique_violation");
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); mocks.clients.length = 0; });

describe("credential-safe diagnostics", () => {
  it("only emits allowlisted categories, including nested database causes", () => {
    expect(safeErrorDiagnostic(sensitiveError())).toBe("database_unique_violation");
    for (const value of [secrets.join(" "), { code: secrets[0] }, { code: "__proto__" }, { status: secrets[0] }]) {
      expect(safeErrorDiagnostic(value)).toBe("operation_failed");
    }
    expect(safeErrorDiagnostic({ code: 401, config: secrets })).toBe("http_401");
    expect(safeErrorDiagnostic({ code: "invalid_grant", response: secrets })).toBe("oauth_reauthorization_required");
  });
  it("handles cycles, hostile getters and arbitrary thrown values without serializing them", () => {
    const cycle: any = { message: secrets[0] }; cycle.cause = cycle;
    const hostile = { get code() { throw sensitiveError(); } };
    for (const value of [cycle, hostile, null, undefined, 42, sensitiveError().toJSON()]) {
      expect(safeErrorDiagnostic(value)).toBe("operation_failed");
    }
  });
  it("redacts the actual failed tokens-event persistence log and preserves refresh semantics", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.updateTokens.mockRejectedValue(sensitiveError());
    await getGmailClientForUser({ id: 42, gmailRefreshToken: secrets[1] } as any);
    mocks.clients[0].emit("tokens", { access_token: secrets[0], expiry_date: 1000 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.updateTokens).toHaveBeenCalledWith(42, {
      gmailAccessToken: secrets[0], gmailTokenExpiresAt: new Date(1000), gmailRefreshToken: undefined,
    });
    expect(log).toHaveBeenCalledTimes(1);
    assertLogsSafe(log);
  });
  it.each(["exchange", "persistence"])("redacts OAuth callback %s failures", async (stage) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const handlers = new Map<string, Function>();
    registerAuthRoutes({ get: (path: string, handler: Function) => handlers.set(path, handler) } as any);
    if (stage === "exchange") mocks.exchange.mockRejectedValue(sensitiveError());
    else {
      mocks.exchange.mockResolvedValue({ user: {}, gmailRefreshToken: secrets[1], gmailAccessToken: secrets[0] });
      mocks.updateTokens.mockRejectedValue(sensitiveError());
    }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handlers.get("/api/auth/callback")!({ query: { code: secrets[4] }, headers: {}, protocol: "https" }, res);
    expect(res.json).toHaveBeenCalledWith({ message: "Authentication failed" });
    assertLogsSafe(log);
  });
  it("redacts global logging and the headers-already-sent fallback", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const next = vi.fn();
    errorHandler(sensitiveError(), { requestId: "synthetic-request" } as any, { headersSent: true } as any, next);
    assertLogsSafe(log);
    expect(next.mock.calls[0][0].message).toBe("database_unique_violation");
    for (const secret of secrets) expect(inspect(next.mock.calls)).not.toContain(secret);
  });
});