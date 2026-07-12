import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

/**
 * Route-level pin for the Task #257 stage seal on the generic
 * PATCH /api/devis/:id.
 *
 * Complements the pure unit tests in
 * server/services/__tests__/devis-stage-guard.test.ts by asserting the
 * HTTP wiring: forward jumps into `sent_to_client` / `client_signed_off`
 * come back as 409 with { message (French), code, currentStage } and
 * NEVER reach storage.updateDevis, while backward corrections still
 * flow through to the update.
 */

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("./helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getUser",
      "getDevis",
      "getProject",
      "getContractor",
      "updateDevis",
      "createDevisRefEdit",
      "getDevisRefEdits",
      "getDevisByProject",
      "getDevisTranslation",
      "updateDevisTranslation",
      "createDevis",
      "getDevisLineItems",
      "createDevisLineItem",
      "updateDevisLineItem",
      "deleteDevisLineItem",
      "getAvenantsByDevis",
      "createAvenant",
      "updateAvenant",
      "countOpenDevisChecks",
      "revokeDevisCheckTokenIfFullyInvoiced",
      "revokeDevisCheckTokensForDevis",
      "getLatestInsuranceOverrideForDevis",
    ]),
  };
});

vi.mock("../../auth/middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 1 };
    next();
  },
}));

vi.mock("../../services/devis-upload.service", () => ({ processDevisUpload: vi.fn() }));
vi.mock("../../services/benchmark-ingest.service", () => ({
  confirmDevisAndMirror: vi.fn(),
  assignTagsForInsertedItems: vi.fn(),
}));
vi.mock("../../services/extraction-validator", () => ({ validateExtraction: vi.fn() }));
vi.mock("../../services/lot-reference-validator", () => ({ checkLotReferencesAgainstCatalog: vi.fn() }));
vi.mock("../../services/insurance-verdict", () => ({ evaluateInsuranceGate: vi.fn() }));
vi.mock("../../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(),
  getAdvisoriesForDevis: vi.fn(),
  acknowledgeAdvisoryForSubject: vi.fn(),
}));
vi.mock("../../services/devis-translation", () => ({
  translateDevis: vi.fn(),
  retranslateSingleLine: vi.fn(),
  triggerDevisTranslation: vi.fn(),
}));
vi.mock("../../communications/devis-translation-generator", () => ({
  generateDevisTranslationPdf: vi.fn(),
  generateCombinedPdf: vi.fn(),
}));
vi.mock("../../storage/object-storage", () => ({ getDocumentStream: vi.fn() }));
vi.mock("../../middleware/upload", () => ({
  upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

import devisRouter from "../devis";
import { storage } from "../../storage";

const getUser = storage.getUser as unknown as ReturnType<typeof vi.fn>;
const getDevis = storage.getDevis as unknown as ReturnType<typeof vi.fn>;
const updateDevis = storage.updateDevis as unknown as ReturnType<typeof vi.fn>;
const revokeIfFullyInvoiced =
  storage.revokeDevisCheckTokenIfFullyInvoiced as unknown as ReturnType<typeof vi.fn>;

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(devisRouter);
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

function makeDevis(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    projectId: 9,
    contractorId: 7,
    lotId: null,
    status: "confirmed",
    devisCode: "GRACE_1348_1",
    devisNumber: "DV1",
    ref2: null,
    amountHt: "1000.00",
    amountTtc: "1200.00",
    signOffStage: "approved_for_signing",
    acompteRequired: false,
    acompteState: "none",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ id: 1, email: "tester@renosud.com" });
  revokeIfFullyInvoiced.mockResolvedValue(undefined);
});

async function patchStage(stage: string) {
  return fetch(`${baseUrl}/api/devis/100`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signOffStage: stage }),
  });
}

describe("PATCH /api/devis/:id — Task #257 stage seal", () => {
  it("409s a forward jump approved_for_signing → sent_to_client with code + currentStage", async () => {
    getDevis.mockResolvedValue(makeDevis({ signOffStage: "approved_for_signing" }));

    const res = await patchStage("sent_to_client");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("manual_send_sealed");
    expect(body.currentStage).toBe("approved_for_signing");
    expect(String(body.message)).toMatch(/signature/i);
    expect(updateDevis).not.toHaveBeenCalled();
  });

  it("409s a direct jump received → client_signed_off (skipping intermediate stages)", async () => {
    getDevis.mockResolvedValue(makeDevis({ signOffStage: "received" }));

    const res = await patchStage("client_signed_off");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("manual_signoff_sealed");
    expect(body.currentStage).toBe("received");
    expect(updateDevis).not.toHaveBeenCalled();
  });

  it("409s sent_to_client → client_signed_off (webhook-owned transition)", async () => {
    getDevis.mockResolvedValue(makeDevis({ signOffStage: "sent_to_client" }));

    const res = await patchStage("client_signed_off");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("manual_signoff_sealed");
    expect(updateDevis).not.toHaveBeenCalled();
  });

  it("still allows the backward correction sent_to_client → approved_for_signing", async () => {
    const before = makeDevis({ signOffStage: "sent_to_client" });
    getDevis.mockResolvedValue(before);
    updateDevis.mockResolvedValue({ ...before, signOffStage: "approved_for_signing" });

    const res = await patchStage("approved_for_signing");
    expect(res.status).toBe(200);
    expect(updateDevis).toHaveBeenCalledTimes(1);
    const [calledId, patch] = updateDevis.mock.calls[0];
    expect(calledId).toBe(100);
    expect(patch.signOffStage).toBe("approved_for_signing");
  });

  it("still allows a same-stage no-op PATCH mentioning the current stage", async () => {
    const before = makeDevis({ signOffStage: "sent_to_client" });
    getDevis.mockResolvedValue(before);
    updateDevis.mockResolvedValue(before);

    const res = await patchStage("sent_to_client");
    expect(res.status).toBe(200);
    expect(updateDevis).toHaveBeenCalledTimes(1);
  });
});
