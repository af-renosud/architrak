import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------
// Webhook-level test: assert that the retention-breach outbound payload
// carries `coveredByLocalCopy` reflecting the local audit-copy state.
// We mock storage + the outbound webhook delivery layer at the boundary
// and capture the payload sent to enqueueOutboundDelivery.
// ---------------------------------------------------------------------

const { storageMock, deliveryMock } = vi.hoisted(() => ({
  storageMock: {
    getDevisByArchisignEnvelopeId: vi.fn(),
    recordSignedPdfRetentionBreach: vi.fn(async (b: { devisId: number }) => ({ id: 1, ...b })),
    getProject: vi.fn(async () => ({ id: 7, archidocProjectId: "ad_7" })),
  },
  deliveryMock: {
    // Match the real EnqueueResult shape: { delivery, enqueued, skipped? }.
    // Returning a clean enqueued result lets us assert no error path was taken.
    enqueueWebhookDelivery: vi.fn(async () => ({
      delivery: { id: 1 },
      enqueued: true,
    })),
  },
}));

vi.mock("../../storage", () => ({ storage: storageMock }));
vi.mock("../../services/webhook-delivery", () => ({
  enqueueWebhookDelivery: deliveryMock.enqueueWebhookDelivery,
}));
vi.mock("../../services/devis-signed-pdf.service", () => ({
  persistSignedDevisPdf: vi.fn(async () => undefined),
}));
vi.mock("../../lib/uuidv7", () => ({ uuidv7: () => "00000000-0000-7000-8000-000000000000" }));

import { handleRetentionBreach, type RetentionBreachPayload } from "../archisign-webhooks";

const basePayload: RetentionBreachPayload = {
  event: "envelope.retention_breach",
  envelopeId: "env_abc",
  incidentRef: "inc_123",
  remediationContact: "ops@archisign.test",
  originalSignedAt: "2026-01-01T12:00:00.000Z",
  detectedAt: "2026-04-01T12:00:00.000Z",
  // Schema may carry additional optional fields — not relevant here.
} as RetentionBreachPayload;

const baseDevis = {
  id: 42,
  projectId: 7,
  signedPdfStorageKey: null as string | null,
};

describe("handleRetentionBreach — coveredByLocalCopy outbound flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits coveredByLocalCopy=true when the devis has a local signed-PDF copy", async () => {
    storageMock.getDevisByArchisignEnvelopeId.mockResolvedValue({
      ...baseDevis,
      signedPdfStorageKey: "object/key/signed.pdf",
    });

    const result = await handleRetentionBreach(basePayload);

    expect(result.status).toBe(200);
    expect(deliveryMock.enqueueWebhookDelivery).toHaveBeenCalledTimes(1);
    const args = deliveryMock.enqueueWebhookDelivery.mock.calls[0][0];
    expect(args.payload).toMatchObject({
      eventType: "signed_pdf_retention_breach",
      coveredByLocalCopy: true,
    });
  });

  it("emits coveredByLocalCopy=false when the devis is missing its local audit copy", async () => {
    storageMock.getDevisByArchisignEnvelopeId.mockResolvedValue({
      ...baseDevis,
      signedPdfStorageKey: null,
    });

    await handleRetentionBreach(basePayload);

    const args = deliveryMock.enqueueWebhookDelivery.mock.calls[0][0];
    expect(args.payload).toMatchObject({
      eventType: "signed_pdf_retention_breach",
      coveredByLocalCopy: false,
    });
  });
});
