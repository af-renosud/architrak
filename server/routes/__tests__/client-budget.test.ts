import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
vi.mock("../../services/client-budget", () => ({
  getClientBudget: vi.fn(), saveClientBudget: vi.fn(),
  ClientBudgetError: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
import { ClientBudgetError, getClientBudget, saveClientBudget } from "../../services/client-budget";
import router from "../client-budget";
let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: req.headers["x-test-user"] ? 7 : undefined } as any; next(); });
  app.use(router);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/1/client-budget`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => vi.clearAllMocks());
const headers = { "x-test-user": "7", "Content-Type": "application/json" };
const body = { version: "a".repeat(64), entries: [{ devisId: 2, title: "Pool", refresh: true }], alternativesReviewed: true };
describe("client budget API boundary", () => {
  it("requires authentication for both reads and writes", async () => {
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { method: "PUT" })).status).toBe(401);
    expect(saveClientBudget).not.toHaveBeenCalled();
  });
  it("reads no-store and binds writes to authenticated actor", async () => {
    vi.mocked(getClientBudget).mockResolvedValue({ version: "a".repeat(64) } as any);
    expect((await fetch(base, { headers })).headers.get("cache-control")).toBe("no-store");
    vi.mocked(saveClientBudget).mockResolvedValue({ version: "b".repeat(64) } as any);
    expect((await fetch(base, { method: "PUT", headers, body: JSON.stringify(body) })).status).toBe(200);
    expect(saveClientBudget).toHaveBeenCalledWith(1, 7, body);
  });
  it.each([
    { ...body, alternativesReviewed: false },
    { ...body, entries: [{ devisId: 2, title: "", refresh: true }] },
    { ...body, entries: [{ devisId: 2, title: "Pool", refresh: true, amountTtc: "0.01" }] },
    { ...body, actorUserId: 99 },
  ])("rejects incomplete or injected payloads", async invalid => {
    expect((await fetch(base, { method: "PUT", headers, body: JSON.stringify(invalid) })).status).toBe(400);
    expect(saveClientBudget).not.toHaveBeenCalled();
  });
  it("returns a recoverable conflict", async () => {
    vi.mocked(saveClientBudget).mockRejectedValue(new ClientBudgetError(409, "Reload and review"));
    const res = await fetch(base, { method: "PUT", headers, body: JSON.stringify(body) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ message: "Reload and review" });
  });
});
