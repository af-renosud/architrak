import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), confirm: vi.fn(), save: vi.fn(), suggest: vi.fn() }));
vi.mock("../../services/architect-quotation-correction", () => ({
  ArchitectCorrectionError: class extends Error { status = 409; code = "ARCHITECT_CORRECTION_CONFLICT"; },
  architectCorrectionService: { get: mocks.get, confirm: mocks.confirm, save: mocks.save },
}));
vi.mock("../../services/devis-translation", () => ({ suggestArchitectTranslation: mocks.suggest }));
import { createArchitectCorrectionRouter } from "../architect-quotation-correction";
const draft = { headerFr: "French",headerEn: "",explanationFr: "",explanationEn: "",summaryEn: "",discountHt: "0.00",lines: [] };
let server: http.Server;
async function mount(auth = true) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (auth) req.session = { userId: 9 } as any; next(); });
  app.use(createArchitectCorrectionRouter());
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/devis/42/architect-correction`;
}
afterEach(async () => { if (server) await new Promise<void>(r => server.close(() => r())); vi.clearAllMocks(); });
describe("architect correction authenticated HTTP perimeter", () => {
  it("rejects unauthenticated reads and writes before touching storage", async () => {
    const url = await mount(false);
    for (const method of ["GET", "PUT", "POST"]) {
      const result = await fetch(method === "POST" ? `${url}/source-baseline` : url, { method });
      expect(result.status).toBe(401);
    }
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("binds actor from the session and returns persistent service responses", async () => {
    const url = await mount();
    mocks.get.mockResolvedValue({ version: "v1",draft }); mocks.save.mockResolvedValue({ version: "v2",draft });
    expect((await (await fetch(url)).json()).version).toBe("v1");
    const body = { ...draft,expectedVersion: "v1" };
    const response = await fetch(url, { method: "PUT",headers: { "Content-Type": "application/json" },body: JSON.stringify(body) });
    expect(response.status).toBe(200); expect((await response.json()).version).toBe("v2");
    expect(mocks.save).toHaveBeenCalledWith(42,body,9);
  });
  it("generates a suggestion from unsaved French without writing or replacing human English", async () => {
    const url = await mount();
    mocks.get.mockResolvedValue({ version: "v1",draft,blockedReason: null });
    mocks.suggest.mockResolvedValue({ header: { description: "English suggestion" },lines: [] });
    const response = await fetch(`${url}/translation-suggestions`, { method: "POST",
      headers: { "Content-Type": "application/json" },body: JSON.stringify({ ...draft,headerFr: "Unsaved French correction",expectedVersion: "v1" }) });
    expect(response.status).toBe(200);
    expect(mocks.suggest).toHaveBeenCalledWith({ ...draft,headerFr: "Unsaved French correction" });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects stale suggestions and unknown financial/header fields", async () => {
    const url = await mount(); mocks.get.mockResolvedValue({ version: "v2",draft,blockedReason: null });
    const response = await fetch(`${url}/translation-suggestions`, { method: "POST",
      headers: { "Content-Type": "application/json" },body: JSON.stringify({ ...draft,expectedVersion: "v1" }) });
    expect(response.status).toBe(409); expect(mocks.suggest).not.toHaveBeenCalled();
    const invalid = await fetch(`${url}/translation-suggestions`, { method: "POST",
      headers: { "Content-Type": "application/json" },body: JSON.stringify({ ...draft,expectedVersion: "v2",sourceTtc: "0.01" }) });
    expect(invalid.status).toBe(400);
  });
});
