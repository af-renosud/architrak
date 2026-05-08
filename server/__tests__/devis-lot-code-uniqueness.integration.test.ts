// Integration tests for the structured-lot-code uniqueness contract
// (Task #176 / #179 / #181). Exercises:
//   * POST /api/devis/:id/confirm — collision returns 409 with a usable
//     `nextLotSequence` body.
//   * PATCH /api/devis/:id (Task #181) — same uniqueness contract on the
//     auth-gated architect-edit path, including the self-exclusion case
//     and the devis_ref_edits audit trail.
//   * GET  /api/projects/:projectId/devis/next-lot-number — suggestion
//     endpoint reflects state and honours `excludeDevisId`.
// Case-insensitivity and exclude-self semantics live in
// `findNextLotSequence` / `isLotSequenceTaken` (both in
// `server/lib/devis-code.ts`); the in-memory mock below mirrors their
// SQL contract so the route contract is verified without a real DB.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { Devis, Project } from "@shared/schema";

interface FakeDevisRow {
  id: number;
  projectId: number;
  lotRefText: string | null;
  lotSequence: number | null;
}

const { state, storageSpy, devisCodeSpy, refEdits } = vi.hoisted(() => {
  const state = {
    nextId: 200,
    devis: [] as FakeDevisRow[],
    projects: [] as Project[],
  };

  const refEdits: Array<Record<string, unknown>> = [];
  const storageSpy = {
    getDevis: vi.fn(async (id: number) => {
      const row = state.devis.find((d) => d.id === id);
      // Return a snapshot so the route's `before` reference does not
      // mutate when `updateDevis` writes back to the same in-memory row.
      return row ? { ...row } : undefined;
    }),
    getProject: vi.fn(async (id: number) => state.projects.find((p) => p.id === id)),
    getLotCatalogEntry: vi.fn(async () => undefined),
    revokeDevisCheckTokenIfFullyInvoiced: vi.fn(async () => undefined),
    getUser: vi.fn(async (id: number) => ({ id, email: `user${id}@example.com` })),
    updateDevis: vi.fn(async (id: number, data: Record<string, unknown>) => {
      const row = state.devis.find((d) => d.id === id) as
        | (FakeDevisRow & Record<string, unknown>)
        | undefined;
      if (!row) return undefined;
      Object.assign(row, data);
      return row;
    }),
    createDevisRefEdit: vi.fn(async (data: Record<string, unknown>) => {
      const row = { id: refEdits.length + 1, ...data };
      refEdits.push(row);
      return row;
    }),
    getContractor: vi.fn(async () => undefined),
  };

  // In-memory replacement for the SQL helpers in `server/lib/devis-code.ts`.
  // Mirrors their case-insensitive `lotRefText` comparison and
  // `excludeDevisId` self-exclusion so the route's 409 / nextLotSequence
  // contract is exercised against realistic uniqueness behaviour.
  const matches = (
    row: FakeDevisRow,
    projectId: number,
    lotRef: string,
    excludeDevisId?: number,
  ) =>
    row.projectId === projectId &&
    row.lotRefText != null &&
    row.lotRefText.toLowerCase() === lotRef.trim().toLowerCase() &&
    row.lotSequence != null &&
    (excludeDevisId == null || row.id !== excludeDevisId);

  const devisCodeSpy = {
    findNextLotSequence: vi.fn(
      async (
        projectId: number,
        lotRef: string,
        opts: { excludeDevisId?: number } = {},
      ) => {
        let max = 0;
        for (const r of state.devis) {
          if (matches(r, projectId, lotRef, opts.excludeDevisId) && r.lotSequence! > max) {
            max = r.lotSequence!;
          }
        }
        return max + 1;
      },
    ),
    isLotSequenceTaken: vi.fn(
      async (
        projectId: number,
        lotRef: string,
        lotSequence: number,
        opts: { excludeDevisId?: number } = {},
      ) =>
        state.devis.some(
          (r) =>
            matches(r, projectId, lotRef, opts.excludeDevisId) &&
            r.lotSequence === lotSequence,
        ),
    ),
  };

  return { state, storageSpy, devisCodeSpy, refEdits };
});

vi.mock("../storage", () => ({ storage: storageSpy }));
vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../auth/middleware", () => ({
  requireAuth: (req: { session?: { userId?: number } }, _res: unknown, next: () => void) => {
    // The PATCH handler reads userId from session for the audit trail; the
    // confirm handler ignores it. Inject a stable test user.
    req.session = req.session ?? { userId: 1 };
    next();
  },
}));
vi.mock("../middleware/upload", () => ({
  assertPdfMagic: vi.fn(),
  upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));
// Re-export the real pure helpers; only the SQL-touching ones are stubbed.
vi.mock("../lib/devis-code", async () => {
  const real = await vi.importActual<typeof import("@shared/devis-code")>("@shared/devis-code");
  return {
    ...real,
    findNextLotSequence: devisCodeSpy.findNextLotSequence,
    isLotSequenceTaken: devisCodeSpy.isLotSequenceTaken,
  };
});
// Heavy services touched by the confirm route on the success path. They
// are not exercised by the 409 collision branch (which short-circuits
// before confirmDevisAndMirror), but importing the route pulls them in.
vi.mock("../services/benchmark-ingest.service", () => ({
  confirmDevisAndMirror: vi.fn(async () => ({ devis: undefined, inserted: [] })),
  assignTagsForInsertedItems: vi.fn(async () => undefined),
}));
vi.mock("../services/extraction-validator", async () => {
  const actual = await vi.importActual<typeof import("../services/extraction-validator")>(
    "../services/extraction-validator",
  );
  return actual;
});
vi.mock("../services/lot-reference-validator", () => ({
  checkLotReferencesAgainstCatalog: vi.fn(async () => []),
}));
vi.mock("../services/advisory-reconciler", () => ({
  reconcileAdvisories: vi.fn(async () => undefined),
  getAdvisoriesForDevis: vi.fn(async () => []),
  acknowledgeAdvisoryForSubject: vi.fn(async () => null),
}));
vi.mock("../services/devis-translation", () => ({
  translateDevis: vi.fn(),
  retranslateSingleLine: vi.fn(),
  triggerDevisTranslation: vi.fn(),
}));
vi.mock("../services/insurance-verdict", () => ({
  evaluateInsuranceGate: vi.fn(async () => ({ proceed: true })),
}));
vi.mock("../communications/devis-translation-generator", () => ({
  generateDevisTranslationPdf: vi.fn(),
  generateCombinedPdf: vi.fn(),
}));
vi.mock("../storage/object-storage", () => ({
  getDocumentStream: vi.fn(),
}));
vi.mock("../gmail/document-parser", () => ({
  PdfPasswordProtectedError: class extends Error {},
}));

import devisRouter from "../routes/devis";
import { errorHandler } from "../middleware/error-handler";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(devisRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function seedDraftDevis(overrides: Partial<FakeDevisRow> = {}): FakeDevisRow {
  const row: FakeDevisRow & Record<string, unknown> = {
    id: state.nextId++,
    projectId: 1,
    lotRefText: null,
    lotSequence: null,
    status: "draft",
    aiExtractedData: {},
    validationWarnings: [],
    ...overrides,
  };
  state.devis.push(row);
  return row;
}

beforeEach(() => {
  state.nextId = 200;
  state.devis = [];
  state.projects = [{ id: 1 } as Project];
  refEdits.length = 0;
  devisCodeSpy.findNextLotSequence.mockClear();
  devisCodeSpy.isLotSequenceTaken.mockClear();
  storageSpy.updateDevis.mockClear();
  storageSpy.createDevisRefEdit.mockClear();
});

describe("structured devis-code uniqueness — confirm route", () => {
  it("second confirm with a colliding (projectId, lotRef, lotSequence) returns 409 with a fresh nextLotSequence", async () => {
    // Existing confirmed devis owns ELEC.1.
    state.devis.push({ id: 100, projectId: 1, lotRefText: "ELEC", lotSequence: 1 });
    const draft = seedDraftDevis();

    const res = await fetch(`${baseUrl}/api/devis/${draft.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lotCode: { lotRefText: "ELEC", lotSequence: 1, lotDescription: "Cabling" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; nextLotSequence: number; message: string };
    expect(body.code).toBe("devis_lot_sequence_taken");
    expect(body.nextLotSequence).toBe(2);
    expect(body.message).toMatch(/already exists/i);
  });

  it("collision detection is case-insensitive on lotRef", async () => {
    state.devis.push({ id: 101, projectId: 1, lotRefText: "ELEC", lotSequence: 4 });
    const draft = seedDraftDevis();

    const res = await fetch(`${baseUrl}/api/devis/${draft.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Lowercase + whitespace — the helper trims and lowers both sides.
        lotCode: { lotRefText: "  elec  ", lotSequence: 4, lotDescription: "Wiring" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { nextLotSequence: number };
    expect(body.nextLotSequence).toBe(5);
  });

  it("returns 400 when the structured lot-code parts fail shared validation (e.g. dot in lotRef)", async () => {
    const draft = seedDraftDevis();

    const res = await fetch(`${baseUrl}/api/devis/${draft.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lotCode: { lotRefText: "EL.EC", lotSequence: 1, lotDescription: "Cabling" },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; errors: Array<{ field: string }> };
    expect(body.code).toBe("devis_code_invalid");
    expect(body.errors.some((e) => e.field === "lotRef")).toBe(true);
  });
});

describe("structured devis-code uniqueness — edit route (PATCH /api/devis/:id)", () => {
  it("collision against another devis returns 409 with a fresh nextLotSequence", async () => {
    state.devis.push({ id: 300, projectId: 1, lotRefText: "ELEC", lotSequence: 1 });
    const editing = seedDraftDevis();

    const res = await fetch(`${baseUrl}/api/devis/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lotCode: { lotRefText: "ELEC", lotSequence: 1, lotDescription: "Cabling" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; nextLotSequence: number };
    expect(body.code).toBe("devis_lot_sequence_taken");
    expect(body.nextLotSequence).toBe(2);
    expect(storageSpy.updateDevis).not.toHaveBeenCalled();
  });

  it("collision detection on the edit path is case-insensitive on lotRef", async () => {
    state.devis.push({ id: 301, projectId: 1, lotRefText: "ELEC", lotSequence: 4 });
    const editing = seedDraftDevis();

    const res = await fetch(`${baseUrl}/api/devis/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lotCode: { lotRefText: "  elec  ", lotSequence: 4, lotDescription: "Wiring" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { nextLotSequence: number };
    expect(body.nextLotSequence).toBe(5);
    expect(storageSpy.updateDevis).not.toHaveBeenCalled();
  });

  it("editing a devis to its own current (lotRef, lotSequence) succeeds via excludeDevisId self-exclusion", async () => {
    // The row currently owns ELEC.7 — re-submitting the same number from the
    // edit dialog must not collide with itself.
    const editing = seedDraftDevis({
      lotRefText: "ELEC",
      lotSequence: 7,
    });

    const res = await fetch(`${baseUrl}/api/devis/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lotCode: { lotRefText: "ELEC", lotSequence: 7, lotDescription: "Cabling" },
      }),
    });

    expect(res.status).toBe(200);
    expect(storageSpy.updateDevis).toHaveBeenCalledTimes(1);
    const [, patchArg] = storageSpy.updateDevis.mock.calls[0]!;
    expect(patchArg).toMatchObject({
      lotRefText: "ELEC",
      lotSequence: 7,
      devisCode: "ELEC.7.Cabling",
    });
    // Both helpers must have been called with the row's own id excluded.
    expect(devisCodeSpy.isLotSequenceTaken).toHaveBeenCalledWith(
      1,
      "ELEC",
      7,
      { excludeDevisId: editing.id },
    );
  });

  it("records the lot-code change in devis_ref_edits for non-draft devis", async () => {
    // For non-draft rows the route writes an audit row whenever the
    // composed `devisCode` actually changes — even though the architect
    // submitted only the structured `lotCode` field, not `devisCode`.
    const editing = seedDraftDevis({
      lotRefText: "ELEC",
      lotSequence: 1,
      status: "finalised",
      devisCode: "ELEC.1.Old description",
    });

    const res = await fetch(`${baseUrl}/api/devis/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lotCode: { lotRefText: "ELEC", lotSequence: 2, lotDescription: "New cabling" },
      }),
    });

    expect(res.status).toBe(200);
    expect(storageSpy.createDevisRefEdit).toHaveBeenCalledTimes(1);
    expect(storageSpy.createDevisRefEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        devisId: editing.id,
        field: "devisCode",
        previousValue: "ELEC.1.Old description",
        newValue: "ELEC.2.New cabling",
        editedByUserId: 1,
        editedByEmail: "user1@example.com",
      }),
    );
  });
});

describe("next-lot-number suggestion endpoint", () => {
  it("returns 1 for an unused lotRef in the project", async () => {
    const res = await fetch(
      `${baseUrl}/api/projects/1/devis/next-lot-number?lotRef=PLUMB`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lotRef: "PLUMB", nextLotSequence: 1 });
  });

  it("suggests max(seq) + 1 across existing rows for the same lotRef", async () => {
    state.devis.push({ id: 110, projectId: 1, lotRefText: "ELEC", lotSequence: 1 });
    state.devis.push({ id: 111, projectId: 1, lotRefText: "elec", lotSequence: 3 });
    state.devis.push({ id: 112, projectId: 1, lotRefText: "GO", lotSequence: 9 });
    state.devis.push({ id: 113, projectId: 2, lotRefText: "ELEC", lotSequence: 99 });

    const res = await fetch(
      `${baseUrl}/api/projects/1/devis/next-lot-number?lotRef=ELEC`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lotRef: "ELEC", nextLotSequence: 4 });
  });

  it("excludes the row currently being edited so the form can keep its own number", async () => {
    state.devis.push({ id: 120, projectId: 1, lotRefText: "ELEC", lotSequence: 7 });

    const including = await fetch(
      `${baseUrl}/api/projects/1/devis/next-lot-number?lotRef=ELEC`,
    );
    expect(await including.json()).toEqual({ lotRef: "ELEC", nextLotSequence: 8 });

    const excluding = await fetch(
      `${baseUrl}/api/projects/1/devis/next-lot-number?lotRef=ELEC&excludeDevisId=120`,
    );
    expect(await excluding.json()).toEqual({ lotRef: "ELEC", nextLotSequence: 1 });
  });

  it("rejects a missing lotRef with 400", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(
      `${baseUrl}/api/projects/1/devis/next-lot-number`,
    );
    errSpy.mockRestore();
    expect(res.status).toBe(400);
  });
});
