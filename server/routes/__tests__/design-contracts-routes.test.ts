import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("./helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getReachedUninvoicedMilestones",
      "getUser",
      "getDesignContractMilestone",
      "getDesignContract",
      "getDesignContractByProjectId",
      "updateDesignContractMilestone",
      "replaceDesignContractForProject",
    ]),
  };
});

vi.mock("../../services/milestone-payment-suggestions.service", () => ({
  transitionMilestoneStatus: vi.fn(),
  markMilestonePaidManually: vi.fn(),
}));

vi.mock("../../services/manual-milestone-invoice.service", () => ({
  recordManualMilestoneInvoice: vi.fn(),
  completePaidMilestoneDetails: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const sess = (req as unknown as { session?: { userId?: number } }).session;
    if (!sess?.userId) {
      return _res.status(401).json({ message: "auth required" });
    }
    next();
  },
}));

import { storage } from "../../storage";
import { errorHandler } from "../../middleware/error-handler";
import {
  transitionMilestoneStatus,
  markMilestonePaidManually,
} from "../../services/milestone-payment-suggestions.service";
import {
  completePaidMilestoneDetails,
  recordManualMilestoneInvoice,
} from "../../services/manual-milestone-invoice.service";

const transitionMock = transitionMilestoneStatus as unknown as ReturnType<typeof vi.fn>;
const markPaidMock = markMilestonePaidManually as unknown as ReturnType<typeof vi.fn>;
const recordInvoiceMock = recordManualMilestoneInvoice as unknown as ReturnType<typeof vi.fn>;
const completeDetailsMock = completePaidMilestoneDetails as unknown as ReturnType<typeof vi.fn>;

const getReached = storage.getReachedUninvoicedMilestones as unknown as ReturnType<typeof vi.fn>;
const getMilestone = storage.getDesignContractMilestone as unknown as ReturnType<typeof vi.fn>;
const getContract = storage.getDesignContract as unknown as ReturnType<typeof vi.fn>;
const updateMilestone = storage.updateDesignContractMilestone as unknown as ReturnType<typeof vi.fn>;

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  // Re-import after mocks so the route file picks up the mocked `requireAuth`.
  const { default: router } = await import("../design-contracts");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Inject a session userId based on a header so tests can switch users.
    const uid = req.header("x-test-user-id");
    (req as unknown as { session: { userId?: number } }).session = uid
      ? { userId: Number(uid) }
      : {};
    next();
  });
  app.use(router);
  app.use(errorHandler);
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
  getReached.mockReset();
  getMilestone.mockReset();
  getContract.mockReset();
  updateMilestone.mockReset();
  transitionMock.mockReset();
  markPaidMock.mockReset();
  recordInvoiceMock.mockReset();
  completeDetailsMock.mockReset();
});

describe("GET /api/design-contracts/dashboard-actions", () => {
  it("returns 401 when no session userId is present", async () => {
    const res = await fetch(`${baseUrl}/api/design-contracts/dashboard-actions`);
    expect(res.status).toBe(401);
    expect(getReached).not.toHaveBeenCalled();
  });

  it("scopes the storage query by the session userId (per-architect)", async () => {
    getReached.mockResolvedValue([]);
    const res = await fetch(`${baseUrl}/api/design-contracts/dashboard-actions`, {
      headers: { "x-test-user-id": "42" },
    });
    expect(res.status).toBe(200);
    expect(getReached).toHaveBeenCalledWith(
      expect.objectContaining({ architectUserId: 42, staleAfterMs: 0, reminderQuietMs: 0 }),
    );
  });
});

describe("PATCH /api/design-contracts/milestones/:id — ownership check", () => {
  it("returns 403 when session user is not the contract uploader", async () => {
    getMilestone.mockResolvedValue({ id: 7, contractId: 3, status: "pending" });
    getContract.mockResolvedValue({ id: 3, uploadedByUserId: 99 });
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ status: "reached" }),
    });
    expect(res.status).toBe(403);
    expect(updateMilestone).not.toHaveBeenCalled();
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("allows the contract uploader to mutate the milestone (CAS transition)", async () => {
    getMilestone.mockResolvedValue({ id: 7, contractId: 3, status: "pending" });
    getContract.mockResolvedValue({ id: 3, uploadedByUserId: 42 });
    transitionMock.mockResolvedValue({ ok: true, milestone: { id: 7, status: "reached" } });
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ status: "reached" }),
    });
    expect(res.status).toBe(200);
    // Status changes go through the compare-and-set service, conditional on
    // the status the route read (paid can never be regressed).
    expect(transitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ milestoneId: 7, expectedStatus: "pending", toStatus: "reached" }),
    );
    expect(updateMilestone).not.toHaveBeenCalled();
  });

  it("rejects legacy status=paid PATCHes because payment details are required", async () => {
    getMilestone.mockResolvedValue({ id: 7, contractId: 3, status: "invoiced" });
    getContract.mockResolvedValue({ id: 3, uploadedByUserId: 42 });
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ status: "paid" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "MILESTONE_PAYMENT_DETAILS_REQUIRED" });
    expect(markPaidMock).not.toHaveBeenCalled();
    expect(transitionMock).not.toHaveBeenCalled();
    expect(updateMilestone).not.toHaveBeenCalled();
  });

  it("rejects stage-skipping Reached → Invoiced through the generic PATCH", async () => {
    getMilestone.mockResolvedValue({ id: 7, contractId: 3, status: "reached" });
    getContract.mockResolvedValue({ id: 3, uploadedByUserId: 42 });
    transitionMock.mockResolvedValue({
      ok: false,
      status: 409,
      code: "MILESTONE_STAGE_SKIP",
      message: "ordered stages",
    });
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ status: "invoiced" }),
    });
    expect(res.status).toBe(409);
    expect(transitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStatus: "reached", toStatus: "invoiced" }),
    );
  });

  it("rejects a CAS miss with 409 so paid can never be regressed", async () => {
    getMilestone.mockResolvedValue({ id: 7, contractId: 3, status: "invoiced" });
    getContract.mockResolvedValue({ id: 3, uploadedByUserId: 42 });
    transitionMock.mockResolvedValue({
      ok: false,
      status: 409,
      code: "MILESTONE_STATUS_CHANGED",
      message: "changed",
    });
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ status: "reached" }),
    });
    expect(res.status).toBe(409);
    expect(updateMilestone).not.toHaveBeenCalled();
  });
});

describe("stage-specific milestone detail endpoints", () => {
  beforeEach(() => {
    (storage.getUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 42,
      email: "owner@test.fr",
    });
  });

  it("requires invoice number and invoice date", async () => {
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7/invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ invoiceNumber: "" }),
    });
    expect(res.status).toBe(400);
    expect(recordInvoiceMock).not.toHaveBeenCalled();
  });

  it("records a manual invoice through the atomic service", async () => {
    recordInvoiceMock.mockResolvedValue({
      ok: true,
      milestone: { id: 7, status: "invoiced" },
      evidence: { id: 10 },
      feeEntryId: 11,
      reconciliation: "created",
    });
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7/invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        invoiceNumber: "FA-2026-100",
        invoiceDate: "2026-08-18",
        notes: "Sent to client",
      }),
    });
    expect(res.status).toBe(201);
    expect(recordInvoiceMock).toHaveBeenCalledWith({
      milestoneId: 7,
      userId: 42,
      actor: "owner@test.fr",
      invoiceNumber: "FA-2026-100",
      invoiceDate: "2026-08-18",
      notes: "Sent to client",
    });
  });

  it("requires a payment date and passes it to the locked payment service", async () => {
    const missing = await fetch(`${baseUrl}/api/design-contracts/milestones/7/payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    markPaidMock.mockResolvedValue({ ok: true, milestone: { id: 7, status: "paid" } });
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7/payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ paymentDate: "2026-08-19", notes: "Bank transfer" }),
    });
    expect(res.status).toBe(200);
    expect(markPaidMock).toHaveBeenCalledWith({
      milestoneId: 7,
      userId: 42,
      actor: "owner@test.fr",
      paymentDate: "2026-08-19",
      notes: "Bank transfer",
    });
  });

  it("completes a paid legacy milestone without a status PATCH", async () => {
    completeDetailsMock.mockResolvedValue({
      ok: true,
      milestone: { id: 7, status: "paid" },
      evidence: { id: 10 },
      feeEntryId: 11,
      reconciliation: "created",
    });
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7/details`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({
        invoiceNumber: "LEG-2025-9",
        invoiceDate: "2025-11-01",
        paymentDate: "2025-11-15",
        notes: "Historical record",
      }),
    });
    expect(res.status).toBe(200);
    expect(completeDetailsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        milestoneId: 7,
        userId: 42,
        invoiceNumber: "LEG-2025-9",
        invoiceDate: "2025-11-01",
        paymentDate: "2025-11-15",
      }),
    );
    expect(transitionMock).not.toHaveBeenCalled();
  });
});

describe("storage.replaceDesignContractForProject — re-upload archive contract", () => {
  it("returns the previous storage key so the route can move it under archive/", async () => {
    const replace = storage.replaceDesignContractForProject as unknown as ReturnType<typeof vi.fn>;
    replace.mockResolvedValue({
      contract: { id: 1, storageKey: "design-contracts/5/active/v2.pdf" },
      milestones: [],
      previousStorageKey: "design-contracts/5/active/v1.pdf",
    });
    const out = await storage.replaceDesignContractForProject(5, {} as never, []);
    expect(out.previousStorageKey).toBe("design-contracts/5/active/v1.pdf");
    expect(out.contract.storageKey).toBe("design-contracts/5/active/v2.pdf");
  });
});
