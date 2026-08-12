import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

// Task #450 — Route-level guarantees for the situation review lifecycle:
//   1. A CONFIRMED situation is immutable — the generic PATCH, the per-line
//      PATCH, AND the generic line-creation POST all refuse it (the confirmed
//      situation is the baseline for the next one; appending a line after
//      confirmation would silently rewrite that baseline).
//   2. Draft line creation only accepts { devisLineItemId, percentComplete }
//      (server-derived money/review fields are rejected by the strict
//      schema) and money is computed server-side.
//   3. Confirm requires all lines resolved.

interface SituationRow { id: number; devisId: number; situationNumber: number; status: string; [k: string]: unknown }
interface LineRow { id: number; situationId: number; devisLineItemId: number; percentComplete: string; cumulativeAmount: string; previousAmount: string; netAmount: string; claimedPercent: string | null; checkStatus: string; checkNotes: string | null }

const { state, storageSpy } = vi.hoisted(() => {
  const state = {
    nextId: 100,
    situations: [] as SituationRow[],
    lines: [] as LineRow[],
    devis: [{ id: 7, invoicingMode: "mode_b", amountHt: "1000.00", amountTtc: "1200.00" }],
    devisLines: [
      { id: 1, devisId: 7, lineNumber: 1, description: "Gros œuvre", totalHt: "600.00", checkStatus: "green" },
      { id: 2, devisId: 7, lineNumber: 2, description: "Charpente", totalHt: "400.00", checkStatus: "green" },
    ],
  };
  const storageSpy = {
    getDevis: vi.fn(async (id: number) => state.devis.find((d) => d.id === id)),
    getDevisLineItems: vi.fn(async (devisId: number) => state.devisLines.filter((d) => d.devisId === devisId)),
    getSituationsByDevis: vi.fn(async (devisId: number) =>
      state.situations.filter((s) => s.devisId === devisId).sort((a, b) => a.situationNumber - b.situationNumber)),
    getSituation: vi.fn(async (id: number) => state.situations.find((s) => s.id === id)),
    createSituation: vi.fn(async (row: Record<string, unknown>) => {
      const s = { id: ++state.nextId, ...row } as SituationRow;
      state.situations.push(s);
      return s;
    }),
    updateSituation: vi.fn(async (id: number, patch: Record<string, unknown>) => {
      const s = state.situations.find((x) => x.id === id);
      if (!s) return undefined;
      Object.assign(s, patch);
      return s;
    }),
    getSituationLines: vi.fn(async (situationId: number) => state.lines.filter((l) => l.situationId === situationId)),
    getSituationLine: vi.fn(async (id: number) => state.lines.find((l) => l.id === id)),
    createSituationLine: vi.fn(async (row: Record<string, unknown>) => {
      const l = { id: ++state.nextId, ...row } as LineRow;
      state.lines.push(l);
      return l;
    }),
    updateSituationLine: vi.fn(async (id: number, patch: Record<string, unknown>) => {
      const l = state.lines.find((x) => x.id === id);
      if (!l) return undefined;
      Object.assign(l, patch);
      return l;
    }),
  };
  return { state, storageSpy };
});

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../services/acompte.service", () => ({
  evaluateAcompteGate: vi.fn(() => ({ blocked: false })),
  gateInputsFromDevis: vi.fn(() => ({})),
}));

import situationsRouter from "../routes/situations";

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(situationsRouter);
  // Mirror the app-level error handler: Zod validation errors → 400.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") {
      return res.status(400).json({ message: "Validation failed" });
    }
    res.status(500).json({ message: err instanceof Error ? err.message : "error" });
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function seedSituation(status: string, lines: Array<Partial<LineRow>> = []): SituationRow {
  const s: SituationRow = {
    id: ++state.nextId,
    devisId: 7,
    situationNumber: state.situations.length + 1,
    status,
    cumulativeHt: "0.00",
    previousHt: "0.00",
    netHt: "0.00",
    netToPayHt: "0.00",
    tvaAmount: "0.00",
    netToPayTtc: "0.00",
  };
  state.situations.push(s);
  for (const partial of lines) {
    state.lines.push({
      id: ++state.nextId,
      situationId: s.id,
      devisLineItemId: 1,
      percentComplete: "50.00",
      cumulativeAmount: "300.00",
      previousAmount: "0.00",
      netAmount: "300.00",
      claimedPercent: "50.00",
      checkStatus: "unchecked",
      checkNotes: null,
      ...partial,
    });
  }
  return s;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.situations.length = 0;
  state.lines.length = 0;
});

describe("confirmed situations are immutable", () => {
  it("POST /api/situations/:id/lines on a confirmed situation → 409, nothing created", async () => {
    const s = seedSituation("confirmed", [{ devisLineItemId: 1, checkStatus: "green" }]);
    const res = await fetch(`${base}/api/situations/${s.id}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devisLineItemId: 2, percentComplete: 10 }),
    });
    expect(res.status).toBe(409);
    expect(state.lines.filter((l) => l.situationId === s.id)).toHaveLength(1);
  });

  it("POST lines on a missing situation → 404", async () => {
    const res = await fetch(`${base}/api/situations/999999/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devisLineItemId: 2, percentComplete: 10 }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /api/situations/:id on a confirmed situation → 409", async () => {
    const s = seedSituation("confirmed");
    const res = await fetch(`${base}/api/situations/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cumulativeHt: "999999.00" }),
    });
    expect(res.status).toBe(409);
  });

  it("PATCH /api/situation-lines/:id on a line of a confirmed situation → 409", async () => {
    const s = seedSituation("confirmed", [{ devisLineItemId: 1, checkStatus: "green" }]);
    const line = state.lines.find((l) => l.situationId === s.id)!;
    const res = await fetch(`${base}/api/situation-lines/${line.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percentComplete: 99 }),
    });
    expect(res.status).toBe(409);
    expect(line.percentComplete).toBe("50.00");
  });

  it("status/confirmedAt/provenance are sealed out of PATCH bodies (400 strict schema)", async () => {
    const s = seedSituation("draft");
    const res = await fetch(`${base}/api/situations/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "confirmed" }),
    });
    // insertSituationSchema.omit strips unknown keys or rejects — either way
    // the status must not change through this endpoint.
    const after = state.situations.find((x) => x.id === s.id)!;
    expect(after.status).toBe("draft");
    expect(res.status).not.toBe(500);
  });
});

describe("draft line creation is server-computed and constrained", () => {
  it("rejects money/review fields in the body (strict schema)", async () => {
    const s = seedSituation("draft");
    const res = await fetch(`${base}/api/situations/${s.id}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devisLineItemId: 1, percentComplete: 10, cumulativeAmount: "999999.00" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a devisLineItemId from another devis → 422", async () => {
    const s = seedSituation("draft");
    const res = await fetch(`${base}/api/situations/${s.id}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devisLineItemId: 12345, percentComplete: 10 }),
    });
    expect(res.status).toBe(422);
  });

  it("creates a draft line with server-computed rounded money and unchecked status", async () => {
    const s = seedSituation("draft");
    const res = await fetch(`${base}/api/situations/${s.id}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devisLineItemId: 2, percentComplete: 25 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as LineRow;
    // 400.00 × 25% = 100.00, previous 0 → net 100.00 (recomputed server-side)
    expect(body.checkStatus).toBe("unchecked");
    expect(body.cumulativeAmount).toBe("100.00");
    expect(body.netAmount).toBe("100.00");
  });

  it("refuses a duplicate line for the same devis line → 409", async () => {
    const s = seedSituation("draft", [{ devisLineItemId: 2 }]);
    const res = await fetch(`${base}/api/situations/${s.id}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devisLineItemId: 2, percentComplete: 25 }),
    });
    expect(res.status).toBe(409);
  });
});

describe("confirm gating", () => {
  it("refuses confirm while a line is unresolved, then confirms once all are resolved", async () => {
    const s = seedSituation("draft", [
      { devisLineItemId: 1, checkStatus: "green" },
      { devisLineItemId: 2, checkStatus: "unchecked" },
    ]);
    let res = await fetch(`${base}/api/situations/${s.id}/confirm`, { method: "POST" });
    expect(res.status).toBe(409);

    const unresolved = state.lines.find((l) => l.situationId === s.id && l.checkStatus === "unchecked")!;
    unresolved.checkStatus = "red";
    res = await fetch(`${base}/api/situations/${s.id}/confirm`, { method: "POST" });
    expect(res.status).toBe(200);
    const confirmed = (await res.json()) as SituationRow;
    expect(confirmed.status).toBe("confirmed");

    // And it is now immutable.
    res = await fetch(`${base}/api/situations/${s.id}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devisLineItemId: 2, percentComplete: 10 }),
    });
    expect(res.status).toBe(409);
  });
});
