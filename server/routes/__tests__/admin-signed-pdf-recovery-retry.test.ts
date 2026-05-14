import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------
// Task #213 — Server-side integration test for the admin signed-PDF
// recovery retry endpoint.
//
// The browser spec stubs this route at the network layer to avoid
// depending on Archisign / object storage in CI. That leaves the
// orchestration in `POST /api/admin/signed-pdf-recovery/:id/retry`
// uncovered end-to-end. This spec exercises the route directly with
// the persist service and storage mocked, asserting the four contract
// branches:
//   1. 409 when the devis isn't in the candidate set
//   2. 409 (+ incidentRef) when the candidate is retention-breached
//   3. 200 + { recovered: true } on the happy path
//   4. 200 + { recovered: false, signedPdfLastError } when persist fails
// ---------------------------------------------------------------------

const { storageMock, persistMock } = vi.hoisted(() => ({
  storageMock: {
    listSignedPdfRecoveryCandidates: vi.fn(),
    clearSignedPdfRetry: vi.fn(async () => undefined),
    getDevis: vi.fn(),
  },
  persistMock: {
    persistSignedDevisPdf: vi.fn(),
  },
}));

vi.mock("../../storage", () => ({ storage: storageMock }));
vi.mock("../../services/devis-signed-pdf.service", () => ({
  persistSignedDevisPdf: persistMock.persistSignedDevisPdf,
}));
vi.mock("../../auth/middleware", () => ({
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  },
}));

import adminSignedPdfRecoveryRouter from "../admin-signed-pdf-recovery";

const baseCandidate = {
  id: 42,
  devisCode: "DEV-2026-014",
  projectId: 7,
  lotId: 3,
  archisignEnvelopeId: "env_abc",
  signedPdfRetryAttempts: 2,
  signedPdfNextAttemptAt: null,
  signedPdfLastError: null,
  dateSigned: "2026-05-08",
  retentionBreachedAt: null as Date | null,
  retentionIncidentRef: null as string | null,
};

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(adminSignedPdfRecoveryRouter);
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ message });
    },
  );
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

async function postRetry(id: number | string): Promise<Response> {
  return await fetch(
    `${baseUrl}/api/admin/signed-pdf-recovery/${id}/retry`,
    { method: "POST" },
  );
}

describe("POST /api/admin/signed-pdf-recovery/:id/retry", () => {
  it("returns 409 when the devis is not in the candidate set", async () => {
    storageMock.listSignedPdfRecoveryCandidates.mockResolvedValueOnce([]);

    const res = await postRetry(42);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string; id: number };
    expect(body.id).toBe(42);
    expect(body.message).toMatch(/not a signed-PDF recovery candidate/i);
    expect(storageMock.clearSignedPdfRetry).not.toHaveBeenCalled();
    expect(persistMock.persistSignedDevisPdf).not.toHaveBeenCalled();
  });

  it("returns 409 with incidentRef when the candidate is retention-breached", async () => {
    storageMock.listSignedPdfRecoveryCandidates.mockResolvedValueOnce([
      {
        ...baseCandidate,
        retentionBreachedAt: new Date("2026-05-01T00:00:00.000Z"),
        retentionIncidentRef: "INC-2026-001",
      },
    ]);

    const res = await postRetry(42);

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      message: string;
      id: number;
      incidentRef: string;
    };
    expect(body).toMatchObject({ id: 42, incidentRef: "INC-2026-001" });
    expect(body.message).toMatch(/retention breached/i);
    expect(storageMock.clearSignedPdfRetry).not.toHaveBeenCalled();
    expect(persistMock.persistSignedDevisPdf).not.toHaveBeenCalled();
  });

  it("returns 200 with recovered: true on the happy path", async () => {
    storageMock.listSignedPdfRecoveryCandidates.mockResolvedValueOnce([
      { ...baseCandidate },
    ]);
    persistMock.persistSignedDevisPdf.mockResolvedValueOnce(undefined);
    storageMock.getDevis.mockResolvedValueOnce({
      id: 42,
      signedPdfStorageKey: ".private/devis/42/signed.pdf",
      signedPdfLastError: null,
      signedPdfRetryAttempts: 0,
    });

    const res = await postRetry(42);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      recovered: boolean;
      signedPdfStorageKey: string | null;
      signedPdfLastError: string | null;
      signedPdfRetryAttempts: number;
    };
    expect(body).toEqual({
      id: 42,
      recovered: true,
      signedPdfStorageKey: ".private/devis/42/signed.pdf",
      signedPdfLastError: null,
      signedPdfRetryAttempts: 0,
    });
    expect(storageMock.clearSignedPdfRetry).toHaveBeenCalledWith(42);
    expect(persistMock.persistSignedDevisPdf).toHaveBeenCalledWith(42);
  });

  it("returns 200 with recovered: false and the persisted error echoed back when persist fails", async () => {
    storageMock.listSignedPdfRecoveryCandidates.mockResolvedValueOnce([
      { ...baseCandidate },
    ]);
    // The service swallows its own failure into signedPdfLastError +
    // arms the retry; from the route's perspective the call resolves
    // and the post-state read shows storage_key still null.
    persistMock.persistSignedDevisPdf.mockResolvedValueOnce(undefined);
    storageMock.getDevis.mockResolvedValueOnce({
      id: 42,
      signedPdfStorageKey: null,
      signedPdfLastError: "fetch_url_expired",
      signedPdfRetryAttempts: 3,
    });

    const res = await postRetry(42);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      recovered: boolean;
      signedPdfStorageKey: string | null;
      signedPdfLastError: string | null;
      signedPdfRetryAttempts: number;
    };
    expect(body).toEqual({
      id: 42,
      recovered: false,
      signedPdfStorageKey: null,
      signedPdfLastError: "fetch_url_expired",
      signedPdfRetryAttempts: 3,
    });
    expect(storageMock.clearSignedPdfRetry).toHaveBeenCalledWith(42);
    expect(persistMock.persistSignedDevisPdf).toHaveBeenCalledWith(42);
  });

  it("returns 500 when the persist service throws synchronously", async () => {
    storageMock.listSignedPdfRecoveryCandidates.mockResolvedValueOnce([
      { ...baseCandidate },
    ]);
    persistMock.persistSignedDevisPdf.mockRejectedValueOnce(
      new Error("object storage unreachable"),
    );

    const res = await postRetry(42);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string; id: number };
    expect(body.id).toBe(42);
    expect(body.message).toMatch(/object storage unreachable/);
    expect(storageMock.clearSignedPdfRetry).toHaveBeenCalledWith(42);
  });
});
