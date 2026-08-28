import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  let user: { email: string } | undefined;
  const quotation = {
    id: 17, projectId: 2, archidocProjectId: "project-test",
    sourceDocumentId: "source-17", sourceSha256: "a".repeat(64),
    fileName: "supplier.pdf", sourcePdf: Buffer.from("%PDF-route-test"),
    extractedPaymentSupplierId: null, extractedSupplierName: "Supplier",
    extractedSupplierSiret: null, matchStatus: "matched", matchReason: null,
    matchEvidence: {}, appointedPaymentSupplierId: null, appointedAt: null,
    appointedByUserId: null, createdAt: new Date(), updatedAt: new Date(),
  };
  return {
    get user() { return user; },
    setUser(value: { email: string } | undefined) { user = value; },
    quotation,
    ingest: vi.fn(async () => quotation),
    confirm: vi.fn(async () => ({ ...quotation, matchStatus: "appointed", appointedPaymentSupplierId: "supplier-1" })),
    getQuotation: vi.fn(async () => quotation),
    sync: vi.fn(async () => 2),
    contractorCalls: vi.fn(),
    devisCalls: vi.fn(),
    certificateCalls: vi.fn(),
  };
});

vi.mock("../../db", () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => fields && "email" in fields
            ? (fake.user ? [fake.user] : [])
            : [{ sequence: BigInt(12), updatedAt: new Date("2026-01-01T00:00:00Z") }],
        }),
      }),
    }),
  },
}));

vi.mock("../../services/payment-supplier-appointment", () => ({
  DrizzleSupplierQuotationRepository: class {
    getQuotation = fake.getQuotation;
  },
  SupplierQuotationError: class SupplierQuotationError extends Error {},
  ingestSupplierQuotation: fake.ingest,
  confirmPaymentSupplierAppointment: fake.confirm,
}));

vi.mock("../../archidoc/payment-supplier-mirror-service", () => ({
  DrizzlePaymentSupplierMirrorStore: class {},
  PAYMENT_SUPPLIER_STREAM: "supplier-payment-readiness.v1",
  syncPaymentSupplierReadiness: fake.sync,
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const router = (await import("../supplier-direct-payment-quotations")).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.header("x-test-actor");
    if (actor) {
      (req as any).session = { userId: actor === "operator" ? 3 : 2 };
      fake.setUser({ email: actor === "operator" ? "architect@renosud.com" : "outside@example.test" });
    } else {
      (req as any).session = undefined;
      fake.setUser(undefined);
    }
    next();
  });
  app.use(router);
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function request(path: string, init: RequestInit = {}, actor?: "operator" | "outsider") {
  const headers = new Headers(init.headers);
  if (actor) headers.set("x-test-actor", actor);
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

describe("supplier direct-payment quotation HTTP routes", () => {
  it("rejects missing and non-firm sessions through the real operator middleware", async () => {
    expect((await request("/api/supplier-direct-payment-quotations/17")).status).toBe(401);
    expect((await request("/api/supplier-direct-payment-quotations/17", {}, "outsider")).status).toBe(403);
  });

  it("serves the complete authenticated multipart quotation journey without legacy paths", async () => {
    const form = new FormData();
    form.set("projectId", "2");
    form.set("archidocProjectId", "project-test");
    form.set("sourceDocumentId", "source-17");
    form.set("extractedSupplierName", "Supplier");
    form.set("file", new Blob([Buffer.from("%PDF-route-test")], { type: "application/pdf" }), "supplier.pdf");
    const ingested = await request("/api/supplier-direct-payment-quotations", {
      method: "POST", body: form,
    }, "operator");
    expect(ingested.status).toBe(201);
    expect(await ingested.json()).toMatchObject({ quotation: { id: 17, fileName: "supplier.pdf" } });
    expect(JSON.stringify(await fake.ingest.mock.results[0].value)).not.toContain("contractor");

    const metadata = await request("/api/supplier-direct-payment-quotations/17", {}, "operator");
    expect(metadata.status).toBe(200);
    expect(JSON.stringify(await metadata.json())).not.toContain("sourcePdf");

    const preview = await request("/api/supplier-direct-payment-quotations/17/preview", {}, "operator");
    expect(preview.headers.get("content-type")).toContain("application/pdf");
    expect(preview.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(fake.quotation.sourcePdf);

    const confirmed = await request("/api/supplier-direct-payment-quotations/17/confirm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentSupplierId: "supplier-1" }),
    }, "operator");
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ quotation: { matchStatus: "appointed" } });
    const confirmedReplay = await request("/api/supplier-direct-payment-quotations/17/confirm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentSupplierId: "supplier-1" }),
    }, "operator");
    expect(confirmedReplay.status).toBe(200);
    expect(fake.confirm).toHaveBeenCalledTimes(2);

    expect((await request("/api/admin/payment-supplier-readiness/status", {}, "operator")).status).toBe(200);
    const sync = await request("/api/admin/payment-supplier-readiness/sync", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, "operator");
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ mode: "incremental", applied: 2 });
    expect(fake.contractorCalls).not.toHaveBeenCalled();
    expect(fake.devisCalls).not.toHaveBeenCalled();
    expect(fake.certificateCalls).not.toHaveBeenCalled();
  });
});