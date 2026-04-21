import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

vi.mock("../../storage", () => ({
  storage: {
    getContractors: vi.fn(),
    getContractor: vi.fn(),
    createContractor: vi.fn(),
    updateContractor: vi.fn(),
    getDevisByContractor: vi.fn(),
    getInvoicesByContractor: vi.fn(),
  },
}));

vi.mock("../../archidoc/contractor-auto-sync", () => ({
  runContractorAutoSync: vi.fn(),
  getLastContractorAutoSync: vi.fn(),
}));

import contractorsRouter from "../contractors";
import { storage } from "../../storage";

const getContractor = storage.getContractor as unknown as ReturnType<typeof vi.fn>;
const updateContractor = storage.updateContractor as unknown as ReturnType<typeof vi.fn>;

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(contractorsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ message });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
});

function makeContractor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    name: "ACME BTP",
    siret: null,
    address: null,
    email: null,
    phone: null,
    defaultTvaRate: "20.00",
    notes: null,
    archidocId: "ad-1",
    contactName: null,
    contactJobTitle: null,
    contactMobile: null,
    town: null,
    postcode: null,
    website: null,
    insuranceStatus: null,
    decennaleInsurer: null,
    decennalePolicyNumber: null,
    decennaleEndDate: null,
    rcProInsurer: null,
    rcProPolicyNumber: null,
    rcProEndDate: null,
    specialConditions: null,
    createdAt: new Date("2026-01-01").toISOString(),
    ...overrides,
  };
}

describe("PATCH /api/contractors/:id (ArchiDoc-linked contractor)", () => {
  it("accepts notes and defaultTvaRate updates and forwards only those fields to storage", async () => {
    getContractor.mockResolvedValue(makeContractor());
    updateContractor.mockImplementation(async (id: number, data: Record<string, unknown>) => ({
      ...makeContractor({ id }),
      ...data,
    }));

    const res = await fetch(`${baseUrl}/api/contractors/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "Prefers email", defaultTvaRate: "10.00" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: 7, notes: "Prefers email", defaultTvaRate: "10.00" });

    expect(updateContractor).toHaveBeenCalledTimes(1);
    const [calledId, payload] = updateContractor.mock.calls[0];
    expect(calledId).toBe(7);
    expect(payload).toEqual({ notes: "Prefers email", defaultTvaRate: "10.00" });
  });

  it("rejects updates that touch ArchiDoc-owned fields with 400 and does not call storage", async () => {
    getContractor.mockResolvedValue(makeContractor());

    const res = await fetch(`${baseUrl}/api/contractors/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", email: "new@acme.example" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/managed in ArchiDoc/i);
    expect(body.errors).toBeDefined();
    expect(updateContractor).not.toHaveBeenCalled();
  });

  it("rejects when notes is valid but is sent alongside an ArchiDoc-owned field", async () => {
    getContractor.mockResolvedValue(makeContractor());

    const res = await fetch(`${baseUrl}/api/contractors/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "ok", siret: "99999999900099" }),
    });

    expect(res.status).toBe(400);
    expect(updateContractor).not.toHaveBeenCalled();
  });

  it("returns 404 when the contractor does not exist", async () => {
    getContractor.mockResolvedValue(undefined);

    const res = await fetch(`${baseUrl}/api/contractors/999`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "x" }),
    });

    expect(res.status).toBe(404);
    expect(updateContractor).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/contractors/:id (unlinked contractor)", () => {
  it("allows updating arbitrary fields when the contractor is not linked to ArchiDoc", async () => {
    getContractor.mockResolvedValue(makeContractor({ archidocId: null }));
    updateContractor.mockImplementation(async (id: number, data: Record<string, unknown>) => ({
      ...makeContractor({ id, archidocId: null }),
      ...data,
    }));

    const res = await fetch(`${baseUrl}/api/contractors/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", email: "new@acme.example" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: "Renamed", email: "new@acme.example" });

    expect(updateContractor).toHaveBeenCalledTimes(1);
    const [, payload] = updateContractor.mock.calls[0];
    expect(payload).toMatchObject({ name: "Renamed", email: "new@acme.example" });
  });
});
