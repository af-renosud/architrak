import { describe, expect, it, vi } from "vitest";
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../financial-summary.service", () => ({ getProjectFinancialSummary: vi.fn() }));
import { budgetCents, budgetState, prepareBudgetEntries, publicBudget } from "../client-budget";
import type { Devis } from "@shared/schema";
import type { ClientBudgetEntry, ClientBudgetSave } from "@shared/client-budget";

const d = (id: number, patch: Partial<Devis> = {}) => ({
  id, projectId: 1, contractorId: 1, devisCode: `D${id}`, devisNumber: `REF${id}`,
  descriptionFr: "Description", descriptionUk: "English title", amountHt: "100.00", amountTtc: "120.00",
  status: "pending", accountingState: "active", signOffStage: "received", ...patch,
} as Devis);
const source = (quotation: Devis) => ({ quotation, contractor: "Contractor" });
const entry: ClientBudgetEntry = { devisId: 1, title: "Reviewed public title", reference: "REF1", contractor: "Contractor", amountHt: "90.00", amountTtc: "108.00" };
const record = { revision: 1, entries: [entry] };
const rows = [source(d(1)), source(d(2, { amountHt: "99999.00", amountTtc: "119998.80" }))];
const state = () => budgetState(record, rows, false);
const input = (refresh = false): ClientBudgetSave => ({ version: state().version, entries: [{ devisId: 1, title: entry.title, refresh }], alternativesReviewed: true });

describe("deliberate client budget disclosure", () => {
  it("accepts exact cents without silently coercing incomplete/negative totals", () => {
    expect(budgetCents("123.45")).toBe(12345);
    expect(budgetCents("0")).toBe(0);
    for (const value of ["", "-1", "1.001", "1,20", "NaN"]) expect(budgetCents(value)).toBeNull();
  });
  it("only discloses explicitly selected snapshots, not other drafts or rich fields", () => {
    const payload = publicBudget(record, rows);
    expect(payload.unsignedTtc).toBe(108);
    expect(payload.entries).toEqual([{ ...entry, status: "under_consideration" }]);
    expect(JSON.stringify(payload)).not.toMatch(/99999|119998|descriptionFr|contractorId/);
  });
  it("retains old prices until explicitly refreshed", () => {
    expect(prepareBudgetEntries(state(), input())[0].amountTtc).toBe("108.00");
    expect(prepareBudgetEntries(state(), input(true))[0].amountTtc).toBe("120.00");
    expect(state().candidates[0].changed).toBe(true);
  });
  it("requires review of current amounts on first inclusion", () => {
    expect(() => prepareBudgetEntries(state(), { ...input(), entries: [{ devisId: 2, title: "Second", refresh: false }] })).toThrow("Review current amounts");
    expect(prepareBudgetEntries(state(), { ...input(), entries: [{ devisId: 2, title: "Second", refresh: true }] })).toHaveLength(1);
  });
  it("permits draft translations; budget sharing does not require finalisation", () => {
    expect(prepareBudgetEntries(state(), input(true))).toHaveLength(1);
  });
  it("keeps a valid shared unsigned amount when current figures become incomplete", () => {
    const damaged = [source(d(1, { amountHt: "", amountTtc: "" }))];
    expect(publicBudget(record, damaged).unsignedTtc).toBe(108);
    expect(budgetState(record, damaged, false).candidates[0].excluded).toBe(false);
  });
  it("moves signed selections out of unsigned totals and uses signed live values", () => {
    const signed = [source(d(1, { signOffStage: "client_signed_off" }))];
    expect(publicBudget(record, signed)).toEqual({ unsignedHt: 0, unsignedTtc: 0, entries: [{
      ...entry, amountHt: "100.00", amountTtc: "120.00", status: "signed",
    }] });
  });
  it.each([
    { status: "void" }, { accountingState: "superseded" }, { accountingState: "provisional" },
    { signOffStage: "client_rejected" }, { signOffStage: "void" },
  ])("excludes inactive selections without exposing replacement automatically: %j", patch => {
    const inactiveRows = [source(d(1, patch)), source(d(3))];
    expect(publicBudget(record, inactiveRows).entries).toEqual([]);
    const s = budgetState(record, inactiveRows, false);
    expect(() => prepareBudgetEntries(s, { ...input(true), version: s.version })).toThrow();
    expect(prepareBudgetEntries(s, { ...input(), version: s.version, entries: [] })).toEqual([]);
  });
  it("rejects duplicate, cross-project/unknown IDs and missing alternatives acknowledgement", () => {
    expect(() => prepareBudgetEntries(state(), { ...input(), entries: [...input().entries, ...input().entries] })).toThrow("only");
    expect(() => prepareBudgetEntries(state(), { ...input(), entries: [{ devisId: 99, title: "Private", refresh: true }] })).toThrow("not found");
    expect(() => prepareBudgetEntries(state(), { ...input(), alternativesReviewed: false } as any)).toThrow("alternative");
  });
  it("rejects stale price and selection versions without applying", () => {
    expect(() => prepareBudgetEntries(budgetState({ ...record, revision: 2 }, rows, false), input())).toThrow("changed");
    expect(() => prepareBudgetEntries(budgetState(record, [source(d(1, { amountTtc: "150.00" }))], false), input())).toThrow("changed");
  });
  it("rejects archived edits and inconsistent totals", () => {
    expect(() => prepareBudgetEntries(budgetState(record, rows, true), input())).toThrow("Archived");
    const s = budgetState({ revision: 0, entries: [] }, [source(d(1, { amountTtc: "80.00" }))], false);
    expect(() => prepareBudgetEntries(s, { ...input(true), version: s.version })).toThrow("inconsistent");
  });
});
