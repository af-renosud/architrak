import { describe, it, expect, vi, beforeEach } from "vitest";

interface InsertCall {
  table: string;
  values: Record<string, unknown>[];
  conflictUpdate?: { target: unknown; set: Record<string, unknown> };
}

interface DeleteCall {
  table: string;
  whereInIds?: string[];
}

const calls: { inserts: InsertCall[]; deletes: DeleteCall[]; updates: any[] } = {
  inserts: [],
  deletes: [],
  updates: [],
};

const tableNameOf = (table: object): string => {
  const sym = Object.getOwnPropertySymbols(table).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "unknown";
};

vi.mock("../db", () => {
  const insertBuilder = (table: object) => {
    const call: InsertCall = { table: tableNameOf(table), values: [] };
    calls.inserts.push(call);
    return {
      values(v: Record<string, unknown> | Record<string, unknown>[]) {
        call.values = Array.isArray(v) ? v : [v];
        return {
          onConflictDoUpdate(opts: { target: unknown; set: Record<string, unknown> }) {
            call.conflictUpdate = opts;
            return Promise.resolve();
          },
          returning() {
            return Promise.resolve(call.values.map((row, i) => ({ ...row, id: i + 1 })));
          },
          then(onFulfilled: (v: unknown) => unknown) {
            return Promise.resolve().then(onFulfilled);
          },
        };
      },
    };
  };

  const deleteBuilder = (table: object) => {
    const call: DeleteCall = { table: tableNameOf(table) };
    calls.deletes.push(call);
    return {
      where(_clause: unknown) {
        return Promise.resolve();
      },
    };
  };

  const updateBuilder = (table: object) => ({
    set(_v: unknown) {
      return {
        where(_c: unknown) {
          return {
            returning() {
              return Promise.resolve([]);
            },
            then(onFulfilled: (v: unknown) => unknown) {
              return Promise.resolve().then(onFulfilled);
            },
          };
        },
      };
    },
  });

  const selectBuilder = () => ({
    from(_t: unknown) {
      return {
        where() {
          return { limit: () => Promise.resolve([]) };
        },
        orderBy() {
          return { limit: () => Promise.resolve([]) };
        },
        limit: () => Promise.resolve([]),
      };
    },
  });

  return {
    db: {
      insert: insertBuilder,
      delete: deleteBuilder,
      update: updateBuilder,
      select: selectBuilder,
    },
    pool: {},
  };
});

vi.mock("../archidoc/sync-client", () => ({
  isArchidocConfigured: () => false,
  fetchProjects: vi.fn(),
  fetchContractors: vi.fn(),
  fetchTrades: vi.fn(),
  fetchProposalFees: vi.fn(),
}));

import { recordSiretIssues, upsertContractor } from "../archidoc/sync-service";
import type { ArchidocContractorData } from "../archidoc/sync-client";

function contractorFixture(overrides: Partial<ArchidocContractorData>): ArchidocContractorData {
  return {
    id: "ad-1",
    name: "ACME",
    ...overrides,
  };
}

describe("recordSiretIssues", () => {
  beforeEach(() => {
    calls.inserts.length = 0;
    calls.deletes.length = 0;
    calls.updates.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("upserts each issue with onConflictDoUpdate", async () => {
    await recordSiretIssues(
      [
        { archidocId: "ad-1", name: "ACME", rawSiret: "bad" },
        { archidocId: "ad-2", name: null, rawSiret: "123" },
      ],
      [],
      99,
    );
    const issueInserts = calls.inserts.filter((c) => c.table === "archidoc_siret_issues");
    expect(issueInserts).toHaveLength(2);
    expect(issueInserts[0].values[0]).toMatchObject({
      archidocId: "ad-1",
      name: "ACME",
      rawSiret: "bad",
      lastSyncLogId: 99,
    });
    expect(issueInserts[0].conflictUpdate?.set).toMatchObject({
      name: "ACME",
      rawSiret: "bad",
      lastSyncLogId: 99,
    });
  });

  it("deletes cleared archidocIds from the issues table", async () => {
    await recordSiretIssues([], ["ad-1", "ad-2"], 1);
    const dels = calls.deletes.filter((d) => d.table === "archidoc_siret_issues");
    expect(dels).toHaveLength(1);
  });

  it("skips delete when no cleared ids", async () => {
    await recordSiretIssues([], [], 1);
    expect(calls.deletes).toHaveLength(0);
  });
});

describe("upsertContractor SIRET issue reporting", () => {
  beforeEach(() => {
    calls.inserts.length = 0;
    calls.deletes.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("flags malformed raw SIRETs", async () => {
    const { siretIssue } = await upsertContractor(
      contractorFixture({ siret: "not-a-siret" }),
    );
    expect(siretIssue).toEqual({ archidocId: "ad-1", name: "ACME", rawSiret: "not-a-siret" });
  });

  it("does not flag valid SIRETs", async () => {
    const { siretIssue } = await upsertContractor(
      contractorFixture({ siret: "82046676100021" }),
    );
    expect(siretIssue).toBeNull();
  });

  it("does not flag empty/missing SIRETs (already nullable)", async () => {
    const a = await upsertContractor(contractorFixture({ id: "ad-1" }));
    const b = await upsertContractor(contractorFixture({ id: "ad-2", siret: "   " }));
    expect(a.siretIssue).toBeNull();
    expect(b.siretIssue).toBeNull();
  });
});
