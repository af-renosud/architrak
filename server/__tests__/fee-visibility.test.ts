import { beforeEach, describe, expect, it, vi } from "vitest";
const { query, release, connect } = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), connect: vi.fn(),
}));
vi.mock("../db", () => ({ pool: { query, connect } }));
import { changeFeeVisibility, feeEntryArchiveBlock, getFeeVisibility } from "../services/fee-visibility.service";

const fee = { id: 10, project_id: 1, fee_amount_ht: "100.00", invoiced_amount: "100.00", pennylane_ref: "INV-1" };
let entries: any[];
let events: any[];
let pending: any[];
beforeEach(() => {
  entries = [{ id: 20, fee_id: 10, status: "invoiced", pennylane_invoice_ref: "INV-1", push_blocked: false }];
  events = [];
  pending = [];
  query.mockReset(); release.mockReset(); connect.mockReset();
  connect.mockResolvedValue({ query, release });
  query.mockImplementation(async (text: string, args?: any[]) => {
    if (text.startsWith("SELECT id FROM projects")) return { rows: [{ id: 1 }] };
    if (text.startsWith("SELECT * FROM fees")) return { rows: [fee] };
    if (text.startsWith("SELECT e.*")) return { rows: entries };
    if (text.startsWith("SELECT project_id")) return { rows: pending };
    if (text.startsWith("SELECT v.*")) return { rows: events };
    if (text.includes("FOR UPDATE OF f") || text.startsWith("SELECT id FROM fees WHERE")) {
      return { rows: args?.[1] === 1 ? [{ id: 10 }] : [] };
    }
    if (text.startsWith("INSERT INTO fee_visibility_events")) {
      events.unshift({ id: events.length + 1, fee_id: args![0], entry_id: args![1], action: args![2],
        reason: args![3], actor: args![4], created_at: new Date("2026-11-14T12:00:00Z") });
    }
    return { rows: [] };
  });
});

describe("fee archive visibility safeguards", () => {
  it("archives and restores visibility without changing financial rows", async () => {
    const args = { projectId: 1, kind: "fee" as const, id: 10, reason: "Completed", actor: "operator" };
    const archived = await changeFeeVisibility({ ...args, action: "archive" });
    expect(archived.records.find(r => r.kind === "fee")?.archived).toBe(true);
    const restored = await changeFeeVisibility({ ...args, action: "restore" });
    expect(restored.records.find(r => r.kind === "fee")?.archived).toBe(false);
    expect(restored.events).toHaveLength(2);
    expect(query.mock.calls.some(([sql]) => /^(UPDATE|DELETE)/.test(sql))).toBe(false);
  });
  it("rejects wrong-project mutation and rolls back", async () => {
    await expect(changeFeeVisibility({ projectId: 2, kind: "entry", id: 20, action: "archive", reason: "Done", actor: "operator" }))
      .rejects.toMatchObject({ status: 404 });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalled();
  });
  it("blocks unresolved child entries, both individually and at parent level", async () => {
    entries[0].status = "pending";
    const state = await getFeeVisibility(1);
    expect(state.records.every(r => !!r.blockedReason)).toBe(true);
    await expect(changeFeeVisibility({ projectId: 1, kind: "fee", id: 10, action: "archive", reason: "Done", actor: "operator" }))
      .rejects.toMatchObject({ status: 409 });
    expect(events).toHaveLength(0);
  });
  it("resurfaces archived work when new unresolved work arrives", async () => {
    events = [{ id: 1, fee_id: 10, entry_id: null, action: "archive", reason: "Done", actor: "operator", created_at: new Date() }];
    pending = [{ candidates: { projects: [{ projectId: 1 }] } }];
    const state = await getFeeVisibility(1);
    expect(state.records.find(r => r.kind === "fee")).toMatchObject({ archived: false });
    expect(state.events).toHaveLength(1);
  });
  it("makes repeated archive requests idempotent", async () => {
    const args = { projectId: 1, kind: "entry" as const, id: 20, action: "archive" as const, reason: "Done", actor: "operator" };
    await changeFeeVisibility(args);
    await changeFeeVisibility(args);
    expect(events).toHaveLength(1);
  });
  it.each([
    [{ status: "pending" }],
    [{ status: "invoiced" }],
    [{ status: "invoiced", pennylane_invoice_ref: "INV", push_blocked: true }],
    [{ status: "invoiced", pennylane_invoice_id: "123", pennylane_status: "unpaid" }],
  ])("blocks insufficient evidence or active accounting work", entry => {
    expect(feeEntryArchiveBlock(entry)).toBeTruthy();
  });
  it("accepts manual invoicing evidence without claiming payment", () => {
    expect(feeEntryArchiveBlock({ status: "invoiced", pennylane_invoice_ref: "INV" })).toBeNull();
  });
});
