import { describe, it, expect, vi, beforeEach } from "vitest";

interface Row {
  id: number;
  devisId: number;
  origin: string;
  lineItemId: number | null;
  status: string;
  query: string;
  createdByUserId: number | null;
  updatedAt: Date;
}

const state: { rows: Row[]; nextId: number; insertCalls: any[] } = {
  rows: [],
  nextId: 1,
  insertCalls: [],
};

vi.mock("../db", () => {
  const insert = (_table: unknown) => ({
    values(v: Record<string, unknown>) {
      const call: any = { values: v, conflict: null as any };
      state.insertCalls.push(call);
      const builder: any = {
        onConflictDoUpdate(opts: { target: unknown; targetWhere?: unknown; set: Record<string, unknown> }) {
          call.conflict = opts;
          return {
            async returning() {
              // Schedule insert at end of microtask queue so two parallel
              // callers can both observe an "empty" table before either
              // commits — exactly the race that previously blew up.
              await Promise.resolve();
              await Promise.resolve();
              return runUpsert(call);
            },
          };
        },
        // If the new code regresses to a plain insert without ON CONFLICT,
        // surface that immediately so the test catches it.
        async returning(): Promise<Row[]> {
          throw new Error(
            "upsertLineItemCheck must use onConflictDoUpdate to be race-safe",
          );
        },
      };
      return builder;
    },
  });

  function runUpsert(call: any): Row[] {
    const v = call.values as Record<string, any>;
    const existingIdx = state.rows.findIndex(
      (r) =>
        r.devisId === v.devisId &&
        r.lineItemId === v.lineItemId &&
        r.origin === "line_item" &&
        r.lineItemId !== null,
    );
    if (existingIdx >= 0) {
      const set = call.conflict.set as Record<string, any>;
      const existing = state.rows[existingIdx];
      Object.assign(existing, set);
      return [existing];
    }
    const row: Row = {
      id: state.nextId++,
      devisId: v.devisId,
      origin: v.origin,
      lineItemId: v.lineItemId,
      status: v.status,
      query: v.query,
      createdByUserId: v.createdByUserId ?? null,
      updatedAt: new Date(),
    };
    state.rows.push(row);
    return [row];
  }

  return {
    db: { insert },
    pool: {},
  };
});

import { storage } from "../storage";

describe("storage.upsertLineItemCheck — race safety", () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.insertCalls.length = 0;
    state.nextId = 1;
  });

  it("uses INSERT ... ON CONFLICT DO UPDATE keyed on the partial unique index", async () => {
    await storage.upsertLineItemCheck(7, 42, "first query", 1);
    expect(state.insertCalls).toHaveLength(1);
    const call = state.insertCalls[0];
    expect(call.conflict).toBeTruthy();
    expect(Array.isArray(call.conflict.target)).toBe(true);
    expect(call.conflict.target).toHaveLength(2);
    // Partial-index predicate must match the schema's WHERE clause so the
    // conflict resolver actually targets the right index.
    expect(call.conflict.targetWhere).toBeDefined();
    expect(call.conflict.set).toMatchObject({ query: "first query" });
  });

  it("two parallel calls succeed, only one row exists, second updates the query text", async () => {
    const [a, b] = await Promise.all([
      storage.upsertLineItemCheck(7, 42, "first query", 1),
      storage.upsertLineItemCheck(7, 42, "second query", 2),
    ]);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Only one row materialised — the unique partial index is honoured.
    const matching = state.rows.filter(
      (r) => r.devisId === 7 && r.lineItemId === 42 && r.origin === "line_item",
    );
    expect(matching).toHaveLength(1);
    // The later upsert wins on the query text.
    expect(matching[0].query).toBe("second query");
    // Both callers received the same row id (they collapsed to one record).
    expect(a.id).toBe(matching[0].id);
    expect(b.id).toBe(matching[0].id);
  });
});
