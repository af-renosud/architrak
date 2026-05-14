import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import crypto from "crypto";
import type { AddressInfo } from "net";

// ---------------------------------------------------------------------
// Integration test for the wiring of `persistSignedDevisPdf` into the
// `envelope.signed` webhook handler.
//
// Two contracts under test:
//   1. The webhook MUST respond 200 within budget even when the
//      detached signed-PDF persistence fails — the architect-facing
//      stage transition is authoritative and Archisign's 5s SLA must
//      be respected regardless of our own audit-copy state.
//   2. The persist call IS dispatched on every delivery (including
//      the fresh transition path) so a redelivered webhook can recover
//      from a prior partial-failure where the stage transition
//      committed but the audit copy did not.
// ---------------------------------------------------------------------

const TEST_SECRET = "test-archisign-webhook-secret";

vi.mock("../../env", () => ({
  env: {
    ARCHISIGN_WEBHOOK_SECRET: "test-archisign-webhook-secret",
  },
}));

const { storageMock, persistMock, deliveryMock } = vi.hoisted(() => ({
  storageMock: {
    claimWebhookEventIn: vi.fn(async () => true),
    getDevisByArchisignEnvelopeId: vi.fn(),
    updateDevis: vi.fn(async () => undefined),
    getDevis: vi.fn(),
    getProject: vi.fn(async () => ({ id: 7, archidocId: "ad_7" })),
    getContractor: vi.fn(async () => undefined),
    getLatestInsuranceOverrideForDevis: vi.fn(async () => undefined),
    armSignedPdfPersistRetry: vi.fn(async () => {}),
  },
  persistMock: {
    persistSignedDevisPdf: vi.fn(),
  },
  deliveryMock: {
    enqueueWebhookDelivery: vi.fn(async () => ({
      delivery: { id: 1 },
      enqueued: true,
    })),
  },
}));

vi.mock("../../storage", () => ({ storage: storageMock }));
vi.mock("../../services/devis-signed-pdf.service", () => ({
  persistSignedDevisPdf: persistMock.persistSignedDevisPdf,
}));
vi.mock("../../services/webhook-delivery", () => ({
  enqueueWebhookDelivery: deliveryMock.enqueueWebhookDelivery,
}));
vi.mock("../../lib/uuidv7", () => ({ uuidv7: () => "00000000-0000-7000-8000-000000000000" }));

import archisignWebhooksRouter from "../archisign-webhooks";

const baseDevis = {
  id: 42,
  projectId: 7,
  contractorId: 11,
  lotId: 3,
  devisCode: "DEV-2026-014",
  archisignEnvelopeId: "env_abc",
  signOffStage: "sent_to_client",
  archidocDqeExportId: null,
  signedPdfStorageKey: null,
};

function signedEnvelopePayload() {
  return {
    event: "envelope.signed",
    eventId: "evt_signed_1",
    occurredAt: "2026-05-08T12:00:00.000Z",
    envelopeId: "env_abc",
    signedAt: "2026-05-08T12:00:00.000Z",
    signedPdfFetchUrl: "https://archisign.test/snap.pdf",
    signedPdfFetchUrlExpiresAt: "2026-05-08T12:15:00.000Z",
    identityVerification: {
      signedAt: "2026-05-08T12:00:00.000Z",
      signerEmail: "client@example.test",
      otpIssuedAt: "2026-05-08T11:59:00.000Z",
      otpVerifiedAt: "2026-05-08T11:59:30.000Z",
      ipAddress: "203.0.113.7",
      userAgent: "ua",
      method: "otp_email",
      lastViewedAt: "2026-05-08T11:58:00.000Z",
    },
  };
}

function signRequest(rawBody: Buffer): { timestamp: string; signature: string } {
  const timestamp = String(Date.now());
  const expected = crypto
    .createHmac("sha256", TEST_SECRET)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]))
    .digest("hex");
  return { timestamp, signature: `sha256=${expected}` };
}

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(archisignWebhooksRouter);
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
  storageMock.claimWebhookEventIn.mockResolvedValue(true);
  storageMock.getDevisByArchisignEnvelopeId.mockResolvedValue({ ...baseDevis });
  storageMock.getDevis.mockResolvedValue({
    ...baseDevis,
    signOffStage: "client_signed_off",
    identityVerification: signedEnvelopePayload().identityVerification,
    signedPdfFetchUrlSnapshot: signedEnvelopePayload().signedPdfFetchUrl,
  });
});

async function postSigned(): Promise<Response> {
  const body = Buffer.from(JSON.stringify(signedEnvelopePayload()), "utf8");
  const { timestamp, signature } = signRequest(body);
  return await fetch(`${baseUrl}/api/webhooks/archisign`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-archisign-timestamp": timestamp,
      "x-archisign-signature": signature,
    },
    body,
  });
}

describe("POST /api/webhooks/archisign — envelope.signed persistence wiring", () => {
  it("returns 200 even when the detached persistSignedDevisPdf throws (best-effort contract)", async () => {
    persistMock.persistSignedDevisPdf.mockRejectedValueOnce(
      new Error("simulated persistence failure"),
    );

    const res = await postSigned();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; transition: string };
    expect(body).toMatchObject({ ok: true, transition: "client_signed_off" });

    // Give the setImmediate task one tick to fire the rejected promise.
    await new Promise((r) => setImmediate(r));
    expect(persistMock.persistSignedDevisPdf).toHaveBeenCalledWith(42);
    // Retry-arming runs synchronously before the response so the
    // sweeper can recover the row even if the detached task crashes.
    expect(storageMock.armSignedPdfPersistRetry).toHaveBeenCalledWith(
      42,
      expect.any(Date),
    );
  });

  it("dispatches persistSignedDevisPdf even on the fresh-transition path so retries can recover partial failures", async () => {
    persistMock.persistSignedDevisPdf.mockResolvedValueOnce(undefined);

    const res = await postSigned();

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(persistMock.persistSignedDevisPdf).toHaveBeenCalledTimes(1);
    expect(persistMock.persistSignedDevisPdf).toHaveBeenCalledWith(42);
  });

  it("still returns 200 (and still dispatches persist) when armSignedPdfPersistRetry fails (fail-open)", async () => {
    storageMock.armSignedPdfPersistRetry.mockRejectedValueOnce(new Error("DB blip"));
    persistMock.persistSignedDevisPdf.mockResolvedValueOnce(undefined);

    const res = await postSigned();

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(persistMock.persistSignedDevisPdf).toHaveBeenCalledWith(42);
  });
});
