import { describe, it, expect, beforeEach, vi } from "vitest";

interface Msg { id: number; checkId: number; authorType: string }

const state: { messages: Msg[]; lastFilter: { checkIds?: number[]; excludeSystem?: boolean } } = {
  messages: [],
  lastFilter: {},
};

vi.mock("../db", () => {
  const select = (_proj?: unknown) => ({
    from(_table: unknown) {
      return {
        where(predicate: { __checkIds?: number[]; __ne?: { col: string; val: string } } | any) {
          state.lastFilter = {
            checkIds: predicate?.__checkIds,
            excludeSystem:
              predicate?.__ne?.col === "author_type" && predicate?.__ne?.val === "system",
          };
          return {
            orderBy(_o: unknown) {
              return {
                async limit(n: number) {
                  let rows = state.messages.slice();
                  if (state.lastFilter.checkIds) {
                    rows = rows.filter((m) => state.lastFilter.checkIds!.includes(m.checkId));
                  }
                  if (state.lastFilter.excludeSystem) {
                    rows = rows.filter((m) => m.authorType !== "system");
                  }
                  rows.sort((a, b) => b.id - a.id);
                  return rows.slice(0, n).map((m) => ({ id: m.id }));
                },
              };
            },
          };
        },
      };
    },
  });
  return { db: { select }, pool: {} };
});

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<any>("drizzle-orm");
  return {
    ...actual,
    inArray: (col: any, vals: number[]) => ({ __checkIds: vals, __col: col?.name }),
    ne: (col: any, val: any) => ({ __ne: { col: col?.name, val } }),
    and: (...preds: any[]) => Object.assign({}, ...preds),
    desc: (col: any) => ({ __desc: col?.name }),
  };
});

import { storage } from "../storage";

describe("storage.getMaxMessageIdForChecks — system rows excluded", () => {
  beforeEach(() => {
    state.messages.length = 0;
    state.lastFilter = {};
  });

  it("returns 0 when no checks are supplied (no DB hit needed)", async () => {
    const out = await storage.getMaxMessageIdForChecks([]);
    expect(out).toBe(0);
  });

  it("ignores 'system' (audit) messages so they cannot bump the dedupe fingerprint", async () => {
    // Two real conversation messages and one later system audit row.
    state.messages.push({ id: 10, checkId: 1, authorType: "architect" });
    state.messages.push({ id: 20, checkId: 1, authorType: "contractor" });
    state.messages.push({ id: 99, checkId: 1, authorType: "system" });
    const out = await storage.getMaxMessageIdForChecks([1]);
    expect(out).toBe(20);
    // Confirm the WHERE clause actually carried the ne(authorType,'system')
    // predicate — defense against a future refactor that drops it.
    expect(state.lastFilter.excludeSystem).toBe(true);
  });

  it("returns 0 when all messages for the checks are system audit rows", async () => {
    state.messages.push({ id: 5, checkId: 7, authorType: "system" });
    state.messages.push({ id: 6, checkId: 7, authorType: "system" });
    const out = await storage.getMaxMessageIdForChecks([7]);
    expect(out).toBe(0);
  });

  it("scopes to the requested checkIds only", async () => {
    state.messages.push({ id: 1, checkId: 1, authorType: "architect" });
    state.messages.push({ id: 50, checkId: 2, authorType: "architect" });
    const out = await storage.getMaxMessageIdForChecks([1]);
    expect(out).toBe(1);
  });
});
