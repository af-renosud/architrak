import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

vi.mock("../../auth/middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 42 };
    next();
  },
}));

vi.mock("../../services/devis-closure.service", async () => {
  const actual = await vi.importActual<typeof import("../../services/devis-closure.service")>(
    "../../services/devis-closure.service",
  );
  return {
    ...actual,
    closeDevisWithApprovedPv: vi.fn(),
  };
});

import devisClosureRouter from "../devis-closure";
import {
  closeDevisWithApprovedPv,
  DevisClosureError,
} from "../../services/devis-closure.service";

const closeDevis = closeDevisWithApprovedPv as unknown as ReturnType<typeof vi.fn>;
let server: import("http").Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(devisClosureRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/devis/:id/close", () => {
  it("returns the audited closed devis", async () => {
    closeDevis.mockResolvedValue({
      alreadyClosed: false,
      devis: {
        id: 9,
        closureState: "closed",
        closedByUserId: 42,
        closedAt: new Date("2026-08-20T08:00:00Z"),
      },
    });

    const response = await fetch(`${baseUrl}/api/devis/9/close`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(closeDevis).toHaveBeenCalledWith(9, 42);
    const body = await response.json();
    expect(body.closureState).toBe("closed");
    expect(body.alreadyClosed).toBe(false);
  });

  it("preserves structured refusal codes and details", async () => {
    closeDevis.mockRejectedValue(
      new DevisClosureError(
        422,
        "PV_RECEPTION_REQUIRED",
        "PV requis",
        { marcheId: 77, pvReceptionStatus: "draft" },
      ),
    );

    const response = await fetch(`${baseUrl}/api/devis/9/close`, { method: "POST" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "PV_RECEPTION_REQUIRED",
      message: "PV requis",
      marcheId: 77,
      pvReceptionStatus: "draft",
    });
  });
});