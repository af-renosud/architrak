import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

vi.mock("../../storage", () => ({
  storage: {
    getReachedUninvoicedMilestones: vi.fn(),
    getDesignContractMilestone: vi.fn(),
    getDesignContractByProjectId: vi.fn(),
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
