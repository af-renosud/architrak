import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

// Mock the two collaborators the upload route wires together. Paths resolve to
// the SAME modules devis.ts imports (server/__tests__/../services/...).
const processDevisUpload = vi.fn();
const enqueueReconciliation = vi.fn();

vi.mock("../services/devis-upload.service", () => ({
  processDevisUpload: (...args: unknown[]) => processDevisUpload(...args),
}));
vi.mock("../services/reconciliation/reconciliation-queue.service", () => ({
  enqueueReconciliation: (...args: unknown[]) => enqueueReconciliation(...args),
  // startReconciliationSweeper is imported elsewhere; keep the module shape safe.
  startReconciliationSweeper: vi.fn(),
}));

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const { default: devisRouter } = await import("../routes/devis");
  const app = express();
  app.use(devisRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function postUpload(): Promise<{ status: number }> {
  const boundary = "----architrak-test-boundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="devis.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    Buffer.from("%PDF-1.4 dummy content"),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/api/projects/42/devis/upload`,
      {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": body.length,
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("POST /api/projects/:projectId/devis/upload — reconciliation wiring (Task #232)", () => {
  it("enqueues reconciliation after a successful upload so the provisional devis gets promoted", async () => {
    processDevisUpload.mockResolvedValue({ success: true, status: 201, data: { devis: { id: 7 } } });

    const res = await postUpload();
    expect(res.status).toBe(201);
    expect(enqueueReconciliation).toHaveBeenCalledTimes(1);
    expect(enqueueReconciliation).toHaveBeenCalledWith(42);
  });

  it("does NOT enqueue reconciliation when the upload fails", async () => {
    processDevisUpload.mockResolvedValue({ success: false, status: 422, data: { message: "bad" } });

    const res = await postUpload();
    expect(res.status).toBe(422);
    expect(enqueueReconciliation).not.toHaveBeenCalled();
  });
});
