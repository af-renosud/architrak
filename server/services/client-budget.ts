import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { clientProjectBudgets, clientProjectShareAudit, contractors, devis, devisTranslations, projects, type Devis } from "@shared/schema";
import type { ClientBudgetEntry, ClientBudgetSave, ClientBudgetState, PublicClientBudget } from "@shared/client-budget";
import { quotationCommitmentStatus } from "@shared/quotation-commitment";
import { getProjectFinancialSummary } from "./financial-summary.service";
import { quotationAmountsUnavailable } from "@shared/quotation-amount-availability";
import { getDocumentBuffer } from "../storage/object-storage";
import { PDFDocument } from "pdf-lib";
import { quotationLifecycleIssues } from "@shared/quotation-decision";

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
function canReviewIndicative(d: Devis) {
  return quotationCommitmentStatus(d) !== "signed" && !quotationLifecycleIssues(d, "indicative_budget").length;
}
function retainedIndicative(d: Devis, entry?: ClientBudgetEntry | null) {
  return canReviewIndicative(d) && entry?.basis === "reviewed_source_total" &&
    entry.sourceReview?.sourceKeyHash === keyHash(d.pdfStorageKey!);
}

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
  if (quotationAmountsUnavailable(d)) return "Extract or enter the quotation figures before including it in the client budget.";
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
    const saved = record.entries.find(e => e.devisId === d.id) ?? null;
    const shared = saved?.basis === "reviewed_source_total" && quotationCommitmentStatus(d) !== "signed"
      && !retainedIndicative(d, saved) ? null : saved;
    return {
      devisId: d.id, internalCode: d.devisCode?.trim() || null, current, shared,
      changed: !!shared && ["reference", "contractor", "amountHt", "amountTtc"].some(k =>
        shared[k as keyof ClientBudgetEntry] !== current[k as keyof ClientBudgetEntry]),
      signed: quotationCommitmentStatus(d) === "signed",
      excluded: !!budgetLifecycleBlock(d) && !canReviewIndicative(d),
      blockedReason: budgetBlockReason(d),
      canReviewIndicative: canReviewIndicative(d),
      figuresUnavailable: quotationAmountsUnavailable(d),
      sourcePdfUrl: d.pdfStorageKey ? `/api/devis/${d.id}/pdf?variant=original` : undefined,
    };
  });
  let signedHt = 0, signedTtc = 0;
  for (const c of candidates) {
    if (c.signed && !c.blockedReason && c.current) {
      signedHt += budgetCents(c.current.amountHt)!;
      signedTtc += budgetCents(c.current.amountTtc)!;
    }
  }
  const version = createHash("sha256").update(JSON.stringify({ record, candidates, readOnly,
    sources: sorted.map(({ quotation: d }) => [d.id, d.pdfStorageKey, d.updatedAt]) })).digest("hex");
  return { version, candidates, signedHt: signedHt / 100, signedTtc: signedTtc / 100, readOnly };
}

export function prepareBudgetEntries(state: ClientBudgetState, input: ClientBudgetSave,
  receipts = new Map<number, NonNullable<ClientBudgetEntry["sourceReview"]>>()): ClientBudgetEntry[] {
  if (state.readOnly) throw new ClientBudgetError(409, "Archived projects cannot change the client budget.");
  if (state.version !== input.version) throw new ClientBudgetError(409, "The quotations or client budget changed. Reload and review before saving; your selections have not been applied.");
  if (!input.alternativesReviewed) throw new ClientBudgetError(400, "Confirm that alternative quotations are not being added together.");
  if (new Set(input.entries.map(e => e.devisId)).size !== input.entries.length) throw new ClientBudgetError(400, "A quotation can only be included once.");
  return input.entries.map(selection => {
    const candidate = state.candidates.find(c => c.devisId === selection.devisId);
    if (!candidate) throw new ClientBudgetError(400, "Quotation not found in this project.");
    if (selection.reviewedTotals) {
      const amount = selection.reviewedTotals;
      const ht = budgetCents(amount.amountHt), ttc = budgetCents(amount.amountTtc);
      const receipt = receipts.get(selection.devisId);
      if (!candidate.canReviewIndicative || candidate.signed || !candidate.current || !receipt)
        throw new ClientBudgetError(409, "Review the original quotation PDF before sharing this indicative total.");
      if (!amount.confirmedFromPdf || !selection.refresh || ht === null || ttc === null || ttc < ht ||
          !selection.title.trim() || receipt.page !== amount.pdfPage)
        throw new ClientBudgetError(400, "Confirm valid HT and TTC totals and their PDF page. This changes the budget only.");
      return { ...candidate.current, title: selection.title.trim(), amountHt: (ht / 100).toFixed(2),
        amountTtc: (ttc / 100).toFixed(2), basis: "reviewed_source_total", sourceReview: receipt };
    }
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
    if (!row || (budgetLifecycleBlock(row.quotation) && !retainedIndicative(row.quotation, shared))) continue;
    if (shared.basis === "reviewed_source_total" && quotationCommitmentStatus(row.quotation) !== "signed"
      && !retainedIndicative(row.quotation, shared)) continue;
    const signed = quotationCommitmentStatus(row.quotation) === "signed";
    if (signed && budgetBlockReason(row.quotation)) continue;
    // Signed commitment is live authoritative financial data; unsigned remains the approved snapshot.
    const entry = signed ? { ...budgetSnapshot(row.quotation, row.contractor), title: shared.title } : shared;
    if (!signed) { ht += budgetCents(entry.amountHt)!; ttc += budgetCents(entry.amountTtc)!; }
    const { sourceReview: _privateEvidence, ...publicEntry } = entry;
    entries.push({ ...publicEntry, status: signed ? "signed" : "under_consideration" });
  }
  return { entries, unsignedHt: ht / 100, unsignedTtc: ttc / 100 };
}

async function loadBudget(projectId: number, tx: typeof db, lock = false) {
  const projectQuery = tx.select().from(projects).where(eq(projects.id, projectId));
  const [project] = await (lock ? projectQuery.for("update") : projectQuery);
  if (!project) throw new ClientBudgetError(404, "Project not found.");
  const [record] = await tx.select().from(clientProjectBudgets).where(eq(clientProjectBudgets.projectId, projectId));
  const query = tx.select({ quotation: devis, contractor: contractors.name, translatedHeader: devisTranslations.headerTranslated }).from(devis)
    .innerJoin(contractors, eq(contractors.id, devis.contractorId))
    .leftJoin(devisTranslations, eq(devisTranslations.devisId, devis.id))
    .where(eq(devis.projectId, projectId)).orderBy(devis.id);
  const result = await (lock ? query.for("share", { of: devis }) : query);
  const rows = result.map(({ quotation, contractor, translatedHeader }) => {
    const english = (translatedHeader as { description?: unknown } | null)?.description;
    return { contractor, quotation: { ...quotation, descriptionUk: quotation.descriptionUk ||
      (typeof english === "string" && english.trim() ? english : null) } };
  });
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
    if (state.version !== input.version || state.readOnly)
      throw new ClientBudgetError(409, "The project or budget changed. Refresh and review before saving.");
    const receipts = new Map<number, NonNullable<ClientBudgetEntry["sourceReview"]>>();
    for (const selection of input.entries.filter(entry => entry.reviewedTotals)) {
      const d = loaded.rows.find(row => row.quotation.id === selection.devisId)?.quotation;
      if (!d || !canReviewIndicative(d)) throw new ClientBudgetError(409, "This quotation cannot be shared as an indicative budget.");
      let bytes: Buffer, pages: number;
      try {
        bytes = await getDocumentBuffer(d.pdfStorageKey!);
        pages = (await PDFDocument.load(bytes)).getPageCount();
      } catch {
        throw new ClientBudgetError(503, "The original PDF could not be opened. No budget amounts were saved. Restore access to the original and retry.");
      }
      const page = selection.reviewedTotals!.pdfPage;
      if (!Number.isSafeInteger(page) || page < 1 || page > pages)
        throw new ClientBudgetError(400, "Choose the page containing the totals in the original PDF.");
      receipts.set(d.id, { digest: createHash("sha256").update(bytes).digest("hex"), page, sourceKeyHash: keyHash(d.pdfStorageKey!) });
    }
    const entries = prepareBudgetEntries(state, input, receipts);
    await tx.insert(clientProjectBudgets).values({ projectId, entries, revision: loaded.record.revision + 1 })
      .onConflictDoUpdate({ target: clientProjectBudgets.projectId, set: { entries, revision: loaded.record.revision + 1, updatedAt: new Date() } });
    await tx.insert(clientProjectShareAudit).values({
      projectId, actorUserId, action: "budget_update",
      detail: JSON.stringify({ before: loaded.record.entries, after: entries, alternativesReviewed: true }),
    });
  });
  return getClientBudget(projectId);
}
