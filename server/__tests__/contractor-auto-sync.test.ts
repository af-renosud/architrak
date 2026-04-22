import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArchidocContractor, Contractor, ArchidocSyncLogEntry } from "@shared/schema";

interface State {
  nextId: number;
  archidocContractors: ArchidocContractor[];
  contractors: Contractor[];
  syncLog: ArchidocSyncLogEntry[];
  updateContractorPayloads: Record<string, unknown>[];
}

const { state, dbSpy, syncContractorsMock, isArchidocConfiguredMock } = vi.hoisted(() => {
  const state: State = {
    nextId: 1000,
    archidocContractors: [],
    contractors: [],
    syncLog: [],
    updateContractorPayloads: [],
  };
  const nid = () => state.nextId++;

  const tableNameOf = (table: object): string => {
    const sym = Object.getOwnPropertySymbols(table).find((s) =>
      String(s).includes("Name"),
    );
    return sym ? String((table as Record<symbol, unknown>)[sym]) : "unknown";
  };

  type Bucket = Record<string, unknown>[];
  const bucketOf = (table: object): Bucket => {
    switch (tableNameOf(table)) {
      case "contractors":
        return state.contractors as unknown as Bucket;
      case "archidoc_contractors":
        return state.archidocContractors as unknown as Bucket;
      case "archidoc_sync_log":
        return state.syncLog as unknown as Bucket;
      default:
        throw new Error(`fake db: unsupported table ${tableNameOf(table)}`);
    }
  };

  const insertBuilder = (table: object) => {
    let values: Record<string, unknown>[] = [];
    const apply = () => {
      const bucket = bucketOf(table);
      const inserted = values.map((v) => {
        const row: Record<string, unknown> = { ...v };
        if (row.id === undefined) row.id = nid();
        bucket.push(row);
        return row;
      });
      return inserted.map((r) => ({ ...r }));
    };
    const b: Record<string, unknown> = {};
    b.values = (v: Record<string, unknown> | Record<string, unknown>[]) => {
      values = Array.isArray(v) ? v : [v];
      return b;
    };
    b.returning = () => Promise.resolve(apply());
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try {
        apply();
        resolve(undefined);
      } catch (e) {
        reject(e);
      }
    };
    return b;
  };

  const updateBuilder = (table: object) => {
    let payload: Record<string, unknown> = {};
    const apply = () => {
      const bucket = bucketOf(table);
      if (tableNameOf(table) === "contractors") {
        // Orphan detection issues an update whose payload is just
        // { archidocOrphanedAt: <Date> } scoped by a notInArray() over the
        // mirror's archidocIds. The fake db has no real WHERE engine, so
        // simulate that scope here: only apply (and only record) the orphan
        // update for contractor rows whose archidocId is NOT present in the
        // current archidoc mirror.
        const isOrphanFlagUpdate =
          Object.keys(payload).length === 1 && "archidocOrphanedAt" in payload;
        if (isOrphanFlagUpdate) {
          const mirrorIds = new Set(
            state.archidocContractors.map((m) => (m as { archidocId: string }).archidocId),
          );
          for (const row of bucket as Array<Record<string, unknown>>) {
            const archidocId = row.archidocId as string | null | undefined;
            if (archidocId && !mirrorIds.has(archidocId) && row.archidocOrphanedAt == null) {
              state.updateContractorPayloads.push({ ...payload });
              Object.assign(row, payload);
            }
          }
          return;
        }
        state.updateContractorPayloads.push({ ...payload });
      }
      // Tests are designed so at most one matching row exists.
      if (bucket[0]) Object.assign(bucket[0], payload);
    };
    const b: Record<string, unknown> = {};
    b.set = (data: Record<string, unknown>) => {
      payload = data;
      return b;
    };
    b.where = () => b;
    b.returning = () => {
      apply();
      const bucket = bucketOf(table);
      return Promise.resolve(bucket.slice(0, 1).map((r) => ({ ...r })));
    };
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try {
        apply();
        resolve(undefined);
      } catch (e) {
        reject(e);
      }
    };
    return b;
  };

  const selectBuilder = () => {
    let table: object | null = null;
    let limitN: number | null = null;
    const b: Record<string, unknown> = {};
    b.from = (t: object) => {
      table = t;
      return b;
    };
    b.where = () => b;
    b.orderBy = () => b;
    b.limit = (n: number) => {
      limitN = n;
      return b;
    };
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try {
        if (!table) throw new Error("fake db select: missing from()");
        const bucket = bucketOf(table);
        const rows = limitN != null ? bucket.slice(0, limitN) : bucket.slice();
        resolve(rows.map((r) => ({ ...r })));
      } catch (e) {
        reject(e);
      }
    };
    return b;
  };

  const dbSpy = {
    insert: vi.fn((table: object) => insertBuilder(table)),
    update: vi.fn((table: object) => updateBuilder(table)),
    select: vi.fn(() => selectBuilder()),
  };

  const syncContractorsMock = vi.fn(async (_incremental: boolean) => ({
    updated: 0 as number,
    error: undefined as string | undefined,
  }));
  const isArchidocConfiguredMock = vi.fn(() => true);

  return { state, dbSpy, syncContractorsMock, isArchidocConfiguredMock };
});

vi.mock("../db", () => ({ db: dbSpy, pool: {} }));
vi.mock("../archidoc/sync-service", () => ({
  syncContractors: syncContractorsMock,
}));
vi.mock("../archidoc/sync-client", () => ({
  isArchidocConfigured: isArchidocConfiguredMock,
}));

import { runContractorAutoSync, CONTRACTOR_AUTO_SYNC_TYPE } from "../archidoc/contractor-auto-sync";

function makeMirror(overrides: Partial<ArchidocContractor> = {}): ArchidocContractor {
  return {
    archidocId: "ad-1",
    name: "ACME BTP",
    siret: "12345678900012",
    address1: "1 rue de Paris",
    address2: null,
    town: "Paris",
    postcode: "75001",
    officePhone: "+33 1 00 00 00 00",
    website: "https://acme.example",
    tradeIds: [],
    insuranceStatus: "valid",
    decennaleInsurer: "AXA",
    decennalePolicyNumber: "DEC-1",
    decennaleEndDate: "2027-01-01",
    rcProInsurer: "AXA",
    rcProPolicyNumber: "RC-1",
    rcProEndDate: "2027-01-01",
    specialConditions: null,
    contacts: [
      { name: "Jane Doe", jobTitle: "Manager", mobile: "+33 6 00 00 00 00", email: "jane@acme.example", isPrimary: true },
    ],
    archidocUpdatedAt: new Date("2026-04-01T00:00:00Z"),
    // Use a future-leaning syncedAt so the non-incremental "fresh mirror"
    // filter (syncedAt >= syncStartedAt) keeps the row regardless of when the
    // test happens to run.
    syncedAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as ArchidocContractor;
}

function resetState() {
  state.nextId = 1000;
  state.archidocContractors = [];
  state.contractors = [];
  state.syncLog = [];
  state.updateContractorPayloads = [];
  syncContractorsMock.mockReset();
  syncContractorsMock.mockResolvedValue({ updated: 1, error: undefined });
  isArchidocConfiguredMock.mockReset();
  isArchidocConfiguredMock.mockReturnValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("runContractorAutoSync", () => {
  beforeEach(resetState);

  it("creates a new contractor with default notes when no local row exists", async () => {
    state.archidocContractors = [makeMirror()];

    const result = await runContractorAutoSync({ incremental: false });

    expect(result.error).toBeUndefined();
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.mirrorUpdated).toBe(1);

    expect(state.contractors).toHaveLength(1);
    const created = state.contractors[0];
    expect(created.archidocId).toBe("ad-1");
    expect(created.name).toBe("ACME BTP");
    expect(created.email).toBe("jane@acme.example");
    expect(created.contactName).toBe("Jane Doe");
    expect(created.address).toBe("1 rue de Paris");
    expect(created.notes).toBeNull();

    expect(state.syncLog).toHaveLength(1);
    expect(state.syncLog[0]).toMatchObject({
      syncType: CONTRACTOR_AUTO_SYNC_TYPE,
      status: "completed",
      recordsUpdated: 1,
    });
    expect(state.syncLog[0].errorMessage ?? null).toBeNull();
  });

  it("preserves local notes when updating an existing linked contractor", async () => {
    state.archidocContractors = [makeMirror({ name: "ACME BTP (renamed)" })];
    state.contractors = [
      {
        id: 42,
        name: "ACME BTP",
        siret: "00000000000000",
        address: "old",
        email: "old@acme.example",
        phone: "old",
        notes: "Local-only note: prefers email contact",
        archidocId: "ad-1",
        contactName: null,
        contactJobTitle: null,
        contactMobile: null,
        town: null,
        postcode: null,
        website: null,
        insuranceStatus: null,
        decennaleInsurer: null,
        decennalePolicyNumber: null,
        decennaleEndDate: null,
        rcProInsurer: null,
        rcProPolicyNumber: null,
        rcProEndDate: null,
        specialConditions: null,
        createdAt: new Date("2026-01-01"),
      } as Contractor,
    ];

    const result = await runContractorAutoSync({ incremental: false });

    expect(result.error).toBeUndefined();
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);

    // Only one update payload was sent and it must NOT include the local-only fields.
    expect(state.updateContractorPayloads).toHaveLength(1);
    const payload = state.updateContractorPayloads[0];
    expect(payload).not.toHaveProperty("notes");
    expect(payload).toMatchObject({
      name: "ACME BTP (renamed)",
      archidocId: "ad-1",
      email: "jane@acme.example",
      siret: "12345678900012",
    });

    // The row in state reflects the update AND keeps local-only fields intact.
    const row = state.contractors[0];
    expect(row.name).toBe("ACME BTP (renamed)");
    expect(row.email).toBe("jane@acme.example");
    expect(row.notes).toBe("Local-only note: prefers email contact");

    expect(state.syncLog[0]).toMatchObject({
      status: "completed",
      recordsUpdated: 1,
    });
  });

  it("records a failed sync log entry when the mirror sync fails", async () => {
    syncContractorsMock.mockResolvedValueOnce({ updated: 0, error: "ArchiDoc 502 Bad Gateway" });

    const result = await runContractorAutoSync({ incremental: false });

    expect(result.error).toBe("ArchiDoc 502 Bad Gateway");
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);

    expect(state.syncLog).toHaveLength(1);
    expect(state.syncLog[0]).toMatchObject({
      syncType: CONTRACTOR_AUTO_SYNC_TYPE,
      status: "failed",
      recordsUpdated: 0,
      errorMessage: "ArchiDoc 502 Bad Gateway",
    });
    expect(state.syncLog[0].completedAt).toBeInstanceOf(Date);

    // No contractors should have been touched.
    expect(state.contractors).toEqual([]);
    expect(state.updateContractorPayloads).toEqual([]);
  });

  it("writes a normalised SIRET on every update, even when the local row had none", async () => {
    state.archidocContractors = [makeMirror({ siret: "820 466 761 00021" })];
    state.contractors = [
      {
        id: 7,
        name: "ACME BTP",
        siret: null,
        address: null,
        email: null,
        phone: null,
        notes: null,
        archidocId: "ad-1",
        contactName: null,
        contactJobTitle: null,
        contactMobile: null,
        town: null,
        postcode: null,
        website: null,
        insuranceStatus: null,
        decennaleInsurer: null,
        decennalePolicyNumber: null,
        decennaleEndDate: null,
        rcProInsurer: null,
        rcProPolicyNumber: null,
        rcProEndDate: null,
        specialConditions: null,
        createdAt: new Date("2026-01-01"),
      } as Contractor,
    ];

    const result = await runContractorAutoSync({ incremental: false });

    expect(result.error).toBeUndefined();
    expect(result.updated).toBe(1);
    expect(state.updateContractorPayloads).toHaveLength(1);
    expect(state.updateContractorPayloads[0]).toMatchObject({ siret: "82046676100021" });
    expect(state.contractors[0].siret).toBe("82046676100021");
  });

  it("coerces a malformed upstream SIRET to null instead of writing garbage", async () => {
    state.archidocContractors = [makeMirror({ siret: "not-a-siret" })];

    const result = await runContractorAutoSync({ incremental: false });

    expect(result.error).toBeUndefined();
    expect(result.created).toBe(1);
    expect(state.contractors[0].siret).toBeNull();
  });

  it("returns early without writing a sync log when ArchiDoc is not configured", async () => {
    isArchidocConfiguredMock.mockReturnValueOnce(false);

    const result = await runContractorAutoSync({ incremental: false });

    expect(result.error).toBe("ArchiDoc not configured");
    expect(state.syncLog).toEqual([]);
    expect(syncContractorsMock).not.toHaveBeenCalled();
  });
});
