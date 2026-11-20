import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { clientProjectBudgets, clientProjectShareAudit, contractors, devis, projects, type Devis } from "@shared/schema";
import type { ClientBudgetEntry, ClientBudgetSave, ClientBudgetState, PublicClientBudget } from "@shared/client-budget";
import { quotationCommitmentStatus } from "@shared/quotation-commitment";
import { getProjectFinancialSummary } from "./financial-summary.service";

export class ClientBudgetError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function budgetCents(value: string): number | null {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function budgetLifecycleBlock(d: Devis): string | null {
  if (["void", "cancelled", "superseded"].includes(d.status) || d.signOffStage === "void" ||
      ["provisional", "superseded"].includes(d.accountingState)) return "Inactive, provisional or replaced quotation — excluded from client budget.";
  if (d.signOffStage === "client_rejected") return "Declined quotation — excluded from client budget.";
  return null;
}

export function budgetBlockReason(d: Devis): string | null {
  const inactive = budgetLifecycleBlock(d);
  if (inactive) return inactive;
  const ht = budgetCents(d.amountHt), ttc = budgetCents(d.amountTtc);
  if (ht === null || ttc === null || ttc < ht) return "Resolve missing or inconsistent HT/TTC totals before sharing.";
  return null;
}

/** Only these fields may cross the budget disclosure boundary. Never spread a devis. */
export function budgetSnapshot(d: Devis, contractor: string): ClientBudgetEntry {
  return {
    devisId: d.id, title: (d.descriptionUk || d.descriptionFr || d.devisCode).slice(0, 500),
    reference: d.devisNumber || d.devisCode, contractor,
    amountHt: d.amountHt, amountTtc: d.amountTtc,
  };
}

type Source = { quotation: Devis; contractor: string };
type BudgetRecord = { revision: number; entries: ClientBudgetEntry[] };
export function budgetState(record: BudgetRecord, rows: Source[], readOnly: boolean): ClientBudgetState {
  const sorted = [...rows].sort((a, b) => a.quotation.id - b.quotation.id);
  const candidates = sorted.map(({ quotation: d, contractor }) => {
    const current = budgetSnapshot(d, contractor);
    const shared = record.entries.find(e => e.devisId === d.id) ?? null;
    return {
      devisId: d.id, current, shared,
      changed: !!shared && ["reference", "contractor", "amountHt", "amountTtc"].some(k =>
        shared[k as keyof ClientBudgetEntry] !== current[k as keyof ClientBudgetEntry]),
      signed: quotationCommitmentStatus(d) === "signed",
      excluded: !!budgetLifecycleBlock(d),
      blockedReason: budgetBlockReason(d),
    };
  });
  let signedHt = 0, signedTtc = 0;
  for (const c of candidates) {
    if (c.signed && !c.blockedReason && c.current) {
      signedHt += budgetCents(c.current.amountHt)!;
      signedTtc += budgetCents(c.current.amountTtc)!;
    }
  }
  const version = createHash("sha256").update(JSON.stringify({ record, candidates, readOnly })).digest("hex");
  return { version, candidates, signedHt: signedHt / 100, signedTtc: signedTtc / 100, readOnly };
}

export function prepareBudgetEntries(state: ClientBudgetState, input: ClientBudgetSave): ClientBudgetEntry[] {
  if (state.readOnly) throw new ClientBudgetError(409, "Archived projects cannot change the client budget.");
  if (state.version !== input.version) throw new ClientBudgetError(409, "The quotations or client budget changed. Reload and review before saving; your selections have not been applied.");
  if (!input.alternativesReviewed) throw new ClientBudgetError(400, "Confirm that alternative quotations are not being added together.");
  if (new Set(input.entries.map(e => e.devisId)).size !== input.entries.length) throw new ClientBudgetError(400, "A quotation can only be included once.");
  return input.entries.map(selection => {
    const candidate = state.candidates.find(c => c.devisId === selection.devisId);
    if (!candidate) throw new ClientBudgetError(400, "Quotation not found in this project.");
    // Retain hidden snapshots for provenance, but never expose inactive entries.
    if (candidate.blockedReason && (selection.refresh || !candidate.shared)) throw new ClientBudgetError(409, candidate.blockedReason);
    const source = selection.refresh ? candidate.current : candidate.shared;
    if (!source) throw new ClientBudgetError(400, "Review current amounts before including this quotation.");
    if (!selection.title.trim()) throw new ClientBudgetError(400, "Enter a client-facing title.");
    return { ...source, title: selection.title.trim() };
  });
}

export function publicBudget(record: BudgetRecord, rows: Source[]): PublicClientBudget {
  let ht = 0, ttc = 0;
  const entries: PublicClientBudget["entries"] = [];
  for (const shared of record.entries) {
    const row = rows.find(r => r.quotation.id === shared.devisId);
    if (!row || budgetLifecycleBlock(row.quotation)) continue;
    const signed = quotationCommitmentStatus(row.quotation) === "signed";
    if (signed && budgetBlockReason(row.quotation)) continue;
    // Signed commitment is live authoritative financial data; unsigned remains the approved snapshot.
    const entry = signed ? { ...budgetSnapshot(row.quotation, row.contractor), title: shared.title } : shared;
    if (!signed) { ht += budgetCents(entry.amountHt)!; ttc += budgetCents(entry.amountTtc)!; }
    entries.push({ ...entry, status: signed ? "signed" : "under_consideration" });
  }
  return { entries, unsignedHt: ht / 100, unsignedTtc: ttc / 100 };
}

async function loadBudget(projectId: number, tx: typeof db, lock = false) {
  const projectQuery = tx.select().from(projects).where(eq(projects.id, projectId));
  const [project] = await (lock ? projectQuery.for("update") : projectQuery);
  if (!project) throw new ClientBudgetError(404, "Project not found.");
  const [record] = await tx.select().from(clientProjectBudgets).where(eq(clientProjectBudgets.projectId, projectId));
  const query = tx.select({ quotation: devis, contractor: contractors.name }).from(devis)
    .innerJoin(contractors, eq(contractors.id, devis.contractorId)).where(eq(devis.projectId, projectId)).orderBy(devis.id);
  const rows = await (lock ? query.for("share", { of: devis }) : query);
  return { record: record ?? { revision: 0, entries: [] }, rows, readOnly: !!project.archivedAt || project.status === "archived" };
}

export async function getClientBudget(projectId: number) {
  const state = await db.transaction(async tx => {
    const loaded = await loadBudget(projectId, tx as unknown as typeof db);
    return budgetState(loaded.record, loaded.rows, loaded.readOnly);
  }, { isolationLevel: "repeatable read" });
  // Match the existing client financial overview, including its treatment of variations.
  const summary = await getProjectFinancialSummary(projectId);
  if (!summary.success || !("totalContractedHt" in summary.data)) throw new ClientBudgetError(503, "Project totals are unavailable. Please retry before sharing a budget.");
  return { ...state, signedHt: summary.data.totalContractedHt, signedTtc: summary.data.totalContractedTtc };
}

export async function getPublicClientBudget(projectId: number) {
  const loaded = await loadBudget(projectId, db);
  return publicBudget(loaded.record, loaded.rows);
}

export async function saveClientBudget(projectId: number, actorUserId: number, input: ClientBudgetSave) {
  await db.transaction(async tx => {
    const loaded = await loadBudget(projectId, tx as unknown as typeof db, true);
    const state = budgetState(loaded.record, loaded.rows, loaded.readOnly);
    const entries = prepareBudgetEntries(state, input);
    await tx.insert(clientProjectBudgets).values({ projectId, entries, revision: loaded.record.revision + 1 })
      .onConflictDoUpdate({ target: clientProjectBudgets.projectId, set: { entries, revision: loaded.record.revision + 1, updatedAt: new Date() } });
    await tx.insert(clientProjectShareAudit).values({
      projectId, actorUserId, action: "budget_update",
      detail: JSON.stringify({ before: loaded.record.entries, after: entries, alternativesReviewed: true }),
    });
  });
  return getClientBudget(projectId);
}
