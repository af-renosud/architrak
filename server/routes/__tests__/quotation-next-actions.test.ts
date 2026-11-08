import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
vi.mock("../../services/quotation-next-actions", () => ({ getProjectQuotationNextActions: vi.fn() }));
vi.mock("../../services/quotation-next-action-explanation", () => ({
  explainQuotationAction: vi.fn(), actionFingerprint: (action: unknown) => JSON.stringify(action),
}));
vi.mock("../../middleware/rate-limit", () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
import { getProjectQuotationNextActions } from "../../services/quotation-next-actions";
import { explainQuotationAction } from "../../services/quotation-next-action-explanation";
import router from "../quotation-next-actions";
const action = { id: "1:certificate:10", code: "send_certificate", outstandingTtc: "100.00" };
const data = { projectId: 9, generatedAt: "2026-11-08T00:00:00.000Z", actionableCount: 1,
  quotations: { 1: { devisId: 1, actionable: true, actions: [action] } } };
let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.header("x-test-user")) req.session = { userId: 1 } as any; next(); });
  app.use(router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/9/quotation-next-actions`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectQuotationNextActions).mockResolvedValue(data as any);
  vi.mocked(explainQuotationAction).mockResolvedValue({ actionId: action.id, source: "fallback", explanation: "Verified facts" });
});
const explain = (body: unknown = { devisId: 1, actionId: action.id }) =>
  fetch(`${base}/explain`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "yes" }, body: JSON.stringify(body) });

describe("next-action read and explanation endpoints", () => {
  it("requires authentication for both routes", async () => {
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(`${base}/explain`, { method: "POST" })).status).toBe(401);
    expect(getProjectQuotationNextActions).not.toHaveBeenCalled();
  });
  it("reads a project batch with no-store", async () => {
    const response = await fetch(base, { headers: { "x-test-user": "yes" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(data);
    expect(explainQuotationAction).not.toHaveBeenCalled();
  });
  it("refuses unknown or cross-project action IDs before calling AI", async () => {
    expect((await explain({ devisId: 88, actionId: action.id })).status).toBe(409);
    expect(explainQuotationAction).not.toHaveBeenCalled();
  });
  it("accepts identifiers only, never client-supplied facts or amounts", async () => {
    expect((await explain({ devisId: 1, actionId: action.id, outstandingTtc: "1.00" })).status).toBe(400);
    expect(explainQuotationAction).not.toHaveBeenCalled();
  });
  it("returns an explicitly labelled fallback without any financial mutation", async () => {
    const response = await explain();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: "fallback" });
    expect(getProjectQuotationNextActions).toHaveBeenCalledTimes(2);
  });
  it("rejects explanations when facts change during generation", async () => {
    vi.mocked(getProjectQuotationNextActions).mockResolvedValueOnce(data as any)
      .mockResolvedValueOnce({ ...data, quotations: { 1: { actions: [{ ...action, outstandingTtc: "20.00" }] } } } as any);
    expect((await explain()).status).toBe(409);
  });
  it("does not report missing evidence as no action needed or leak errors", async () => {
    vi.mocked(getProjectQuotationNextActions).mockRejectedValueOnce(new Error("secret database info"));
    const response = await fetch(base, { headers: { "x-test-user": "yes" } });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });
});
