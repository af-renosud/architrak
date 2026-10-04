import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

vi.mock("../../services/duplicate-extraction", async () => {
  const actual = await vi.importActual<typeof import("../../services/duplicate-extraction")>("../../services/duplicate-extraction");
  return { ...actual, getDuplicateCorrectionHistory: vi.fn() };
});
import router from "../devis";
import { errorHandler } from "../../middleware/error-handler";
import { CorrectionError, getDuplicateCorrectionHistory } from "../../services/duplicate-extraction";
const history = vi.mocked(getDuplicateCorrectionHistory);
let server: import("http").Server;
let baseUrl: string;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers["x-test-session"] === "operator") req.session = { userId: 1 } as typeof req.session;
    next();
  });
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { history.mockReset(); });
const read = (id: string, authenticated = true) => fetch(`${baseUrl}/api/devis/${id}/duplicate-corrections`,
  { headers: authenticated ? { "x-test-session": "operator" } : {} });

describe("authenticated correction history", () => {
  it("refuses unauthenticated access before reading evidence", async () => {
    expect((await read("42", false)).status).toBe(401);
    expect(history).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "abc", "1.5"])("rejects invalid quotation id %s", async id => {
    expect((await read(id)).status).toBe(400);
    expect(history).not.toHaveBeenCalled();
  });
  it("returns an empty history with no-store caching for an authenticated operator", async () => {
    history.mockResolvedValue([]);
    const response = await read("42");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual([]);
    expect(history).toHaveBeenCalledWith(42);
  });
  it("reports a missing quotation", async () => {
    history.mockRejectedValue(new CorrectionError("Quotation not found", 404));
    expect((await read("999")).status).toBe(404);
  });
  it("does not disguise a failed read as an empty history", async () => {
    history.mockRejectedValue(new Error("database unavailable"));
    expect((await read("42")).status).toBe(500);
  });
});