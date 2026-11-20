import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
const mocks = vi.hoisted(() => ({ getJobsJotter: vi.fn(), saveJobsJotter: vi.fn() }));
vi.mock("../../services/jobs-jotter", () => mocks);
import router from "../jobs-jotter";
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: req.headers["x-test-user"] ? Number(req.headers["x-test-user"]) : undefined } as any;
    next();
  });
  app.use(router);
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jobs-jotter`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => vi.resetAllMocks());
describe("private Jobs jotter API", () => {
  it("requires authentication for reads and saves", async () => {
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { method: "PUT" })).status).toBe(401);
    expect(mocks.getJobsJotter).not.toHaveBeenCalled();
    expect(mocks.saveJobsJotter).not.toHaveBeenCalled();
  });
  it("reads only the current user's jotter, without caching private notes", async () => {
    mocks.getJobsJotter.mockResolvedValue({ content: "Call supplier", revision: 2, updatedAt: null });
    const res = await fetch(`${base}?userId=99`, { headers: { "x-test-user": "7" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).content).toBe("Call supplier");
    expect(mocks.getJobsJotter).toHaveBeenCalledWith(7);
  });
  it("saves and clears with the authenticated owner and revision", async () => {
    mocks.saveJobsJotter.mockResolvedValue({ saved: { content: "", revision: 3, updatedAt: null } });
    const res = await fetch(base, { method: "PUT", headers: { "x-test-user": "7", "Content-Type": "application/json" }, body: JSON.stringify({ content: "", revision: 2 }) });
    expect(res.status).toBe(200);
    expect(mocks.saveJobsJotter).toHaveBeenCalledWith(7, "", 2);
  });
  it("returns a recoverable conflict without claiming a save", async () => {
    const current = { content: "Newer note", revision: 3, updatedAt: null };
    mocks.saveJobsJotter.mockResolvedValue({ current });
    const res = await fetch(base, { method: "PUT", headers: { "x-test-user": "7", "Content-Type": "application/json" }, body: JSON.stringify({ content: "Old note", revision: 2 }) });
    expect(res.status).toBe(409);
    expect((await res.json()).current).toEqual(current);
  });
  it.each([
    { content: "x", revision: -1 },
    { content: "x" },
    { content: "x", revision: 0, userId: 99 },
    { content: "x".repeat(100001), revision: 0 },
  ])("rejects malformed or owner-injected requests", async body => {
    const res = await fetch(base, { method: "PUT", headers: { "x-test-user": "7", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(mocks.saveJobsJotter).not.toHaveBeenCalled();
  });
});
