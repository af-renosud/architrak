import { describe, expect, it } from "vitest";
import type { ArchitectFeeInvoice } from "@shared/schema";
import type { FeeVisibilityRecord } from "@shared/fee-visibility";
import { detectedForProject, feeGroupMatchesVisibility, feeEntryMatchesVisibility, matchesVisibility, registerTotals, unassignedDetected } from "../fee-register";

describe("fee register evidence and visibility boundaries", () => {
  const row = (id: number, projects: number[], amountTtc = "1337.00") => ({
    id, amountTtc, candidates: { projects: projects.map(projectId => ({ projectId })) },
  }) as ArchitectFeeInvoice;
  it("scopes by explicit project candidates, never equal amounts", () => {
    const rows = [row(1, [8]), row(2, [9]), row(3, [])];
    expect(detectedForProject(rows, "8").map(item => item.id)).toEqual([1]);
    expect(unassignedDetected(rows).map(item => item.id)).toEqual([3]);
    expect(detectedForProject(rows, "")).toEqual(rows);
  });
  it("does not infer visibility when the API has no record", () => {
    expect(matchesVisibility(undefined, "active")).toBe(false);
    expect(matchesVisibility(undefined, "all")).toBe(false);
    const archived = { archived: true } as FeeVisibilityRecord;
    expect(matchesVisibility(archived, "active")).toBe(false);
    expect(matchesVisibility(archived, "archived")).toBe(true);
    expect(matchesVisibility(archived, "all")).toBe(true);
    expect(matchesVisibility({ ...archived, archived: false, archivedAt: "2026-01-11" }, "active")).toBe(true);
  });
  it("includes explicitly assigned documents without candidates and excludes them from unassigned", () => {
    const assigned = { ...row(4, []), projectId: 8, candidates: null };
    const assignedWithCandidates = { ...row(5, [9]), projectId: 8 };
    const unassigned = row(6, []);
    const rows = [assigned, assignedWithCandidates, unassigned];
    expect(detectedForProject(rows, "8").map(item => item.id)).toEqual([4, 5]);
    expect(unassignedDetected(rows).map(item => item.id)).toEqual([6]);
  });
});
describe("parent/entry archive filtering", () => {
  const record = (kind: "fee" | "entry", id: number, archived: boolean): FeeVisibilityRecord => ({
    kind, id, archived, archivedAt: archived ? "2026-02-17T08:24:00Z" : null, reason: archived ? "Reconciled" : null, blockedReason: null,
  });
  it("hides an archived parent from Active despite an invoiced unarchived child; restores it to Active", () => {
    const invoicedChild = { id: 27, feeId: 4, status: "invoiced" };
    const child = record("entry", invoicedChild.id, false);
    const activeParent = record("fee", invoicedChild.feeId, false);
    expect(feeGroupMatchesVisibility(activeParent, [child], "active")).toBe(true);
    const archivedParent = { ...activeParent, archived: true };
    expect(feeGroupMatchesVisibility(archivedParent, [child], "active")).toBe(false);
    expect(feeEntryMatchesVisibility(archivedParent, child, "active")).toBe(false);
    expect(feeGroupMatchesVisibility(archivedParent, [child], "archived")).toBe(true);
    expect(feeEntryMatchesVisibility(archivedParent, child, "archived")).toBe(true);
    expect(feeEntryMatchesVisibility(archivedParent, child, "all")).toBe(true);
    const restoredParent = { ...archivedParent, archived: false };
    expect(feeGroupMatchesVisibility(restoredParent, [child], "active")).toBe(true);
    expect(feeEntryMatchesVisibility(restoredParent, child, "active")).toBe(true);
    expect(feeGroupMatchesVisibility(restoredParent, [child], "archived")).toBe(false);
  });
  it("preserves independently archived children after a parent restore", () => {
    const parent = record("fee", 4, true);
    const children = [record("entry", 27, false), record("entry", 28, true)];
    expect(children.filter(child => feeEntryMatchesVisibility(parent, child, "archived")).map(child => child.id)).toEqual([27, 28]);
    const restoredParent = { ...parent, archived: false };
    expect(feeGroupMatchesVisibility(restoredParent, children, "active")).toBe(true);
    expect(feeGroupMatchesVisibility(restoredParent, children, "archived")).toBe(true);
    expect(children.filter(child => feeEntryMatchesVisibility(restoredParent, child, "active")).map(child => child.id)).toEqual([27]);
    expect(children.filter(child => feeEntryMatchesVisibility(restoredParent, child, "archived")).map(child => child.id)).toEqual([28]);
    expect(children[1].archived).toBe(true);
  });
  it("never guesses missing parent state from child state", () => {
    for (const filter of ["active", "archived", "all"] as const) {
      expect(feeGroupMatchesVisibility(undefined, [record("entry", 27, true)], filter)).toBe(false);
      expect(feeEntryMatchesVisibility(undefined, record("entry", 27, true), filter)).toBe(false);
    }
  });
});
describe("contract-aware full register totals", () => {
  const fees = [
    { id: 4, feeAmountHt: "8800", invoicedAmount: "2200" },
    { id: 7, feeAmountHt: "327.15", invoicedAmount: "107.45" },
  ];
  const contract = { coveredFeeIds: [4], totalHt: 8800, totalTtc: 10560, invoicedHt: 2200, invoicedTtc: 2640 };
  it("replaces contract mirrors without double-counting", () => {
    const totals = registerTotals(fees, contract);
    expect(totals.totalFeeEarned).toBeCloseTo(9127.15);
    expect(totals.totalInvoiced).toBeCloseTo(2307.45);
    expect(totals.totalRemainingTtc).toBeCloseTo(8183.64);
  });
  it("retains unknown documentary HT instead of applying a guessed TVA rate", () => {
    const totals = registerTotals(fees, { ...contract, totalHt: null, invoicedHt: null });
    expect(totals.totalFeeEarned).toBeNull();
    expect(totals.totalInvoiced).toBeNull();
    expect(totals.totalRemaining).toBeNull();
    expect(totals.totalFeeEarnedTtc).toBeCloseTo(10952.58);
  });
  it("does not treat independently missing invoiced HT as zero", () => {
    expect(registerTotals(fees, { ...contract, invoicedHt: null }).totalInvoiced).toBeNull();
  });
  it("supports no contract or no fees", () => {
    expect(registerTotals([], null).totalFeeEarnedTtc).toBe(0);
    expect(registerTotals([fees[1]], null).totalRemaining).toBeCloseTo(219.7);
  });
});
