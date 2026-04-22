import { describe, it, expect, beforeEach, vi } from "vitest";

interface Row {
  id: number;
  projectId: number;
  type: string;
  recipientType: string;
  recipientEmail: string | null;
  recipientName: string | null;
  subject: string;
  body: string | null;
  status: string;
  dedupeKey: string | null;
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
        onConflictDoNothing(opts?: { target?: unknown }) {
          call.conflict = opts ?? { target: null };
          return {
            async returning(): Promise<Row[]> {
              const v2 = call.values as Record<string, any>;
              if (v2.dedupeKey) {
                const existing = state.rows.find((r) => r.dedupeKey === v2.dedupeKey);
                if (existing) return [];
              }
              const row: Row = {
                id: state.nextId++,
                projectId: v2.projectId,
                type: v2.type ?? "general",
                recipientType: v2.recipientType,
                recipientEmail: v2.recipientEmail ?? null,
                recipientName: v2.recipientName ?? null,
                subject: v2.subject,
                body: v2.body ?? null,
                status: v2.status ?? "draft",
                dedupeKey: v2.dedupeKey ?? null,
              };
              state.rows.push(row);
              return [row];
            },
          };
        },
        async returning(): Promise<Row[]> {
          const v2 = call.values as Record<string, any>;
          const row: Row = {
            id: state.nextId++,
            projectId: v2.projectId,
            type: v2.type ?? "general",
            recipientType: v2.recipientType,
            recipientEmail: v2.recipientEmail ?? null,
            recipientName: v2.recipientName ?? null,
            subject: v2.subject,
            body: v2.body ?? null,
            status: v2.status ?? "draft",
            dedupeKey: v2.dedupeKey ?? null,
          };
          state.rows.push(row);
          return [row];
        },
      };
      return builder;
    },
  });

  const select = () => ({
    from(_table: unknown) {
      return {
        where(predicate: { __dedupeKey?: string; __id?: number }) {
          // The storage helpers we exercise pass either a dedupeKey eq() or
          // an id eq(); our captured predicate carries that intent.
          return Promise.resolve(
            state.rows.filter((r) => {
              if (predicate.__dedupeKey !== undefined) return r.dedupeKey === predicate.__dedupeKey;
              if (predicate.__id !== undefined) return r.id === predicate.__id;
              return false;
            }),
          );
        },
      };
    },
  });

  return { db: { insert, select }, pool: {} };
});

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<any>("drizzle-orm");
  return {
    ...actual,
    eq: (col: any, val: any) => {
      const name = col?.name;
      if (name === "dedupe_key") return { __dedupeKey: val };
      if (name === "id") return { __id: val };
      return {};
    },
  };
});

import { storage } from "../storage";

describe("storage.createProjectCommunication — dedupe defense in depth", () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.insertCalls.length = 0;
    state.nextId = 1;
  });

  it("uses INSERT ... ON CONFLICT DO NOTHING targeting dedupe_key when a dedupeKey is supplied", async () => {
    await storage.createProjectCommunication({
      projectId: 1,
      type: "devis_check_bundle",
      recipientType: "contractor",
      recipientEmail: "a@e.com",
      recipientName: "Acme",
      subject: "Subj",
      body: "Body",
      status: "queued",
      dedupeKey: "devis-check-bundle:1:m0:7",
    } as any);
    expect(state.insertCalls).toHaveLength(1);
    const call = state.insertCalls[0];
    expect(call.conflict).toBeTruthy();
    expect(call.conflict.target).toBeDefined();
  });

  it("two parallel inserts with the same dedupeKey collapse to a single row, both callers see the same id", async () => {
    const data = {
      projectId: 1,
      type: "devis_check_bundle",
      recipientType: "contractor",
      recipientEmail: "a@e.com",
      recipientName: "Acme",
      subject: "Subj",
      body: "Body",
      status: "queued",
      dedupeKey: "devis-check-bundle:1:m0:7",
    } as any;
    const [a, b] = await Promise.all([
      storage.createProjectCommunication(data),
      storage.createProjectCommunication(data),
    ]);
    expect(a.id).toBe(b.id);
    const matching = state.rows.filter((r) => r.dedupeKey === "devis-check-bundle:1:m0:7");
    expect(matching).toHaveLength(1);
  });

  it("falls back to a plain insert when no dedupeKey is provided (general comms keep working)", async () => {
    const created = await storage.createProjectCommunication({
      projectId: 1,
      type: "general",
      recipientType: "client",
      recipientEmail: "c@e.com",
      recipientName: "Client",
      subject: "Hi",
      body: "Hello",
      status: "draft",
    } as any);
    expect(created.id).toBeGreaterThan(0);
    expect(state.insertCalls).toHaveLength(1);
    expect(state.insertCalls[0].conflict).toBeNull();
  });
});
