import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

vi.mock("../../storage", () => ({
  storage: {
    getReachedUninvoicedMilestones: vi.fn(),
    getDesignContractMilestone: vi.fn(),
    getDesignContract: vi.fn(),
    getDesignContractByProjectId: vi.fn(),
    updateDesignContractMilestone: vi.fn(),
    replaceDesignContractForProject: vi.fn(),
  },
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
  });

  it("allows the contract uploader to mutate the milestone", async () => {
    getMilestone.mockResolvedValue({ id: 7, contractId: 3, status: "pending" });
    getContract.mockResolvedValue({ id: 3, uploadedByUserId: 42 });
    updateMilestone.mockResolvedValue({ id: 7, status: "reached" });
    const res = await fetch(`${baseUrl}/api/design-contracts/milestones/7`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user-id": "42" },
      body: JSON.stringify({ status: "reached" }),
    });
    expect(res.status).toBe(200);
    expect(updateMilestone).toHaveBeenCalledWith(7, expect.objectContaining({ status: "reached" }));
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
