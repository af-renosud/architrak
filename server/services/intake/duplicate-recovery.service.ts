import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import type { DbTransaction } from "../../storage";
import {
  projects, projectIntakeDocuments, devis, invoices, situations, marcheDocuments,
  intakeJobs, acompteNoInvoicePayments, invoiceAcompteApplications, intakeManualPromotions,
  type ProjectIntakeDocument,
} from "@shared/schema";
import { normalizeRef } from "@shared/intake-dedup";
import type { IntakeDuplicateSummary } from "@shared/intake-duplicate";

type Reader = typeof db | DbTransaction;
const data = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
const idOf = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
function duplicateData(doc: ProjectIntakeDocument) {
  const value = { ...data(doc.extractedData) };
  // Read-only compatibility with older generated same-reference review notes.
  if (doc.routingState === "parked" && !value.possibleDuplicateOfDevisId && !value.possibleDuplicateOfInvoiceId) {
    const legacy = (doc.notes ?? "").split("\n").find(line => /^Possible (?:duplicate|revision) — review before routing:/.test(line))
      ?.match(/existing (devis|invoice) .+? \(#(\d+)\)/);
    if (legacy) value[legacy[1] === "devis" ? "possibleDuplicateOfDevisId" : "possibleDuplicateOfInvoiceId"] = Number(legacy[2]);
  }
  return value;
}
export class DuplicateRecoveryError extends Error {
  readonly status = 409;
}
export function isDuplicateCandidate(doc: ProjectIntakeDocument) {
  const e = duplicateData(doc);
  return doc.routingState === "duplicate" || !!(e.duplicateOfIntakeDocumentId || e.duplicateOfDevisId || e.duplicateOfInvoiceId || e.possibleDuplicateOfDevisId || e.possibleDuplicateOfInvoiceId);
}

async function context(reader: Reader, projectId: number, lock = false) {
  const p = reader.select().from(projects).where(eq(projects.id, projectId));
  const [project] = await (lock ? p.for("update") : p);
  const sourceQuery = reader.select().from(projectIntakeDocuments).where(eq(projectIntakeDocuments.projectId, projectId));
  const docs = await (lock ? sourceQuery.for("update") : sourceQuery);
  const dq = reader.select().from(devis).where(eq(devis.projectId, projectId));
  const iq = reader.select().from(invoices).where(eq(invoices.projectId, projectId));
  const ds = await (lock ? dq.for("update") : dq);
  const invs = await (lock ? iq.for("update") : iq);
  return { project, docs, ds, invs };
}
type Context = Awaited<ReturnType<typeof context>>;

async function resolve(reader: Reader, doc: ProjectIntakeDocument, ctx: Context) {
  const initial = data(doc.extractedData);
  const result: IntakeDuplicateSummary = {
    intakeId: doc.id, originalId: null, originalHref: null,
    match: doc.routingState === "parked" ? "possible" : initial.duplicateOfIntakeDocumentId ? (initial.contentHash ? "content" : "exact") : "reference",
    lifecycle: "missing", label: "Original document unavailable", href: null,
    explanation: "The original destination could not be found in this project.",
    recovery: null, blockedReason: null, version: "",
  };
  let canonical = doc;
  const visited = new Set<number>([doc.id]);
  let broken = false;
  while (idOf(data(canonical.extractedData).duplicateOfIntakeDocumentId)) {
    const nextId = idOf(data(canonical.extractedData).duplicateOfIntakeDocumentId)!;
    if (visited.has(nextId) || visited.size > 32) { broken = true; break; }
    visited.add(nextId);
    const next = ctx.docs.find(d => d.id === nextId);
    if (!next) { broken = true; break; }
    canonical = next;
  }
  const c = duplicateData(canonical);
  if (!broken && canonical.id !== doc.id) {
    result.originalId = canonical.id;
    result.originalHref = `/projets/${doc.projectId}?tab=intake&intake=${canonical.id}&includeVoid=true`;
  }
  const recovered = data(c.duplicateRecoveryTarget);
  const ownedDevis = ctx.ds.find(d => d.sourceIntakeDocumentId === canonical.id);
  const ownedInvoice = ctx.invs.find(i => i.sourceIntakeDocumentId === canonical.id);
  const kind = recovered.kind || canonical.promotedKind || (ownedDevis ? "devis" : ownedInvoice ? "invoice" : null)
    || (c.duplicateOfDevisId || c.possibleDuplicateOfDevisId ? "devis" : c.duplicateOfInvoiceId || c.possibleDuplicateOfInvoiceId ? "invoice" : null);
  const targetId = idOf(recovered.id) ?? canonical.promotedId ?? ownedDevis?.id ?? ownedInvoice?.id ?? idOf(c.duplicateOfDevisId ?? c.possibleDuplicateOfDevisId ?? c.duplicateOfInvoiceId ?? c.possibleDuplicateOfInvoiceId);
  const target = broken ? undefined : kind === "devis" ? ctx.ds.find(d => d.id === targetId)
    : kind === "invoice" ? ctx.invs.find(i => i.id === targetId) : undefined;
  let parsed = data(canonical.extractedData);
  if (target) {
    parsed = { ...data(target.aiExtractedData), ...parsed };
    const historical = target.status === "void" || ("accountingState" in target && target.accountingState === "superseded");
    result.lifecycle = historical ? "historical" : "active";
    const ref = "devisCode" in target ? target.devisNumber || target.devisCode : target.invoiceNumber;
    result.label = `${kind === "devis" ? "Devis" : "Invoice"} ${ref} — ${historical ? target.status === "void" ? "void" : "superseded" : target.status}`;
    result.href = kind === "devis" ? `/projets/${doc.projectId}?tab=devis&devis=${target.id}&includeVoid=true`
      : `/projets/${doc.projectId}?tab=factures&invoice=${target.id}&includeVoid=true`;
    result.explanation = historical ? "Previously processed, but this record is not in the live workflow. The original history will be preserved."
      : "This document already has a record in the live workflow.";
    if (target.status === "void") result.recovery = "draft";
    else result.blockedReason = historical ? "A superseded record must be resolved through its replacement; it cannot be recreated here." : "Open the existing record instead of creating another.";
    // A reference match is conservative: even a differently priced active revision blocks recovery.
    const refKey = normalizeRef(ref);
    const equivalents = kind === "devis" ? ctx.ds : ctx.invs;
    if (historical && equivalents.some(other =>
      other.id !== target.id && other.status !== "void"
      && (!("accountingState" in other) || other.accountingState !== "superseded")
      && other.contractorId === target.contractorId
      && refKey && ("devisCode" in other
        ? [other.devisCode, other.devisNumber].some(r => normalizeRef(r) === refKey)
        : normalizeRef(other.invoiceNumber) === refKey))) {
      result.blockedReason = "An active record with this contractor and reference exists. Inspect that record before recovery.";
    }
    if (result.recovery) {
      if (ctx.docs.some(other => {
        if (other.id === canonical.id || other.id === doc.id || other.contentFingerprint !== doc.contentFingerprint) return false;
        const d = other.promotedKind === "devis" ? ctx.ds.find(t => t.id === other.promotedId)
          : other.promotedKind === "invoice" ? ctx.invs.find(t => t.id === other.promotedId) : null;
        return d && d.status !== "void";
      })) result.blockedReason = "The identical PDF already has another active workflow record.";
      const refs = kind === "devis"
        ? await reader.execute(sql`SELECT 1 WHERE
            EXISTS (SELECT 1 FROM invoices WHERE devis_id=${target.id})
            OR EXISTS (SELECT 1 FROM situations WHERE devis_id=${target.id})
            OR EXISTS (SELECT 1 FROM avenants WHERE devis_id=${target.id})
            OR EXISTS (SELECT 1 FROM fee_entries WHERE devis_id=${target.id})
            OR EXISTS (SELECT 1 FROM acompte_no_invoice_payments WHERE devis_id=${target.id})
            OR EXISTS (SELECT 1 FROM invoice_acompte_applications WHERE devis_id=${target.id})
            OR EXISTS (SELECT 1 FROM marche_documents WHERE devis_id=${target.id})`)
        : await reader.execute(sql`SELECT 1 WHERE
            EXISTS (SELECT 1 FROM certificat_sources WHERE invoice_id=${target.id})
            OR EXISTS (SELECT 1 FROM situations WHERE invoice_id=${target.id})
            OR EXISTS (SELECT 1 FROM fee_entries WHERE invoice_id=${target.id})
            OR EXISTS (SELECT 1 FROM certificat_payments WHERE invoice_allocations @> jsonb_build_array(jsonb_build_object('invoiceId', ${target.id}::int)))
            OR EXISTS (SELECT 1 FROM invoice_acompte_applications WHERE invoice_id=${target.id})`);
      if (refs.rows.length || ("datePaid" in target && target.datePaid)
        || ("dateSigned" in target && (target.dateSigned || target.signedPdfStorageKey || target.archisignEnvelopeId || target.acomptePaidAt || target.acompteState === "paid" || target.closureState === "closed"))) {
        result.blockedReason = "The historical record has financial, contractual or signed evidence. Resolve those links before recovery.";
      }
      if (kind === "invoice") {
        const parent = ctx.ds.find(d => d.id === (target as typeof invoices.$inferSelect).devisId);
        if (!parent || parent.status === "void" || parent.accountingState === "superseded") result.blockedReason = "The invoice's parent devis is not active.";
      }
    }
  } else if (!broken && targetId && (kind === "situation" || kind === "commande" || kind === "marche_document")) {
    const [evidence] = kind === "situation"
      ? await reader.select().from(situations).where(eq(situations.id, targetId))
      : await reader.select().from(marcheDocuments).where(eq(marcheDocuments.id, targetId));
    const parent = evidence?.devisId ? ctx.ds.find(d => d.id === evidence.devisId) : undefined;
    if (parent) {
      result.lifecycle = parent.status === "void" ? "historical" : "active";
      result.label = `${kind === "situation" ? "Situation" : "Order evidence"} #${targetId} on devis ${parent.devisNumber || parent.devisCode}`;
      result.href = `/projets/${doc.projectId}?tab=devis&devis=${parent.id}&includeVoid=true`;
      result.evidenceHref = kind === "situation"
        ? ("sourceStorageKey" in evidence! && evidence.sourceStorageKey ? `/api/situations/${targetId}/source` : null)
        : `/api/marche-documents/${targetId}/download`;
      result.explanation = "This document is retained as evidence on the linked devis.";
    }
    result.blockedReason = "Linked evidence must be managed on its existing record.";
  } else if (!broken && !targetId && canonical.id !== doc.id) {
    result.lifecycle = "unprocessed";
    result.label = `${canonical.fileName} — ${canonical.analysisState}/${canonical.routingState}`;
    result.explanation = "An earlier intake copy exists, but it has not become a workflow record.";
    result.recovery = "resume";
    if (["pending", "analyzing"].includes(canonical.analysisState)) result.blockedReason = "The original is already processing. Open it to follow progress.";
    // Do not requeue an original behind a second, older canonical anchor.
    if (ctx.docs.some(other => other.id !== canonical.id && other.id !== doc.id && other.routingState !== "duplicate"
      && other.analysisState === "analyzed" && other.contentFingerprint === canonical.contentFingerprint)) {
      result.blockedReason = "Another processed source exists for these bytes. Inspect the originals before recovery.";
    }
  }
  if (broken) result.explanation = "The duplicate reference is missing, belongs to another project, or forms a cycle. No automatic recovery is safe.";
  if (result.match === "possible") {
    result.explanation = `Possible revision, not a proven identical document. ${result.explanation}`;
    result.blockedReason = "Compare the documents and use the existing reviewed revision workflow.";
  }
  const sourceIds = Array.from(visited);
  if (result.recovery) {
    const protectedRows = await reader.select({ id: acompteNoInvoicePayments.id }).from(acompteNoInvoicePayments)
      .where(inArray(acompteNoInvoicePayments.sourceIntakeDocumentId, sourceIds));
    const applications = await reader.select({ id: invoiceAcompteApplications.id }).from(invoiceAcompteApplications)
      .where(inArray(invoiceAcompteApplications.sourceIntakeDocumentId, sourceIds));
    const promotions = await reader.select().from(intakeManualPromotions).where(inArray(intakeManualPromotions.intakeDocumentId, sourceIds));
    // Previous audited promotion of the ORIGINAL is history, not authority to alter it.
    if (protectedRows.length || applications.length || (result.recovery === "resume" && promotions.length)) result.blockedReason = "The source is immutable financial or reviewed promotion evidence.";
  }
  if (!ctx.project || ctx.project.archivedAt || ctx.project.status === "archived") result.blockedReason = "Archived or missing projects are read-only.";
  if (doc.promotedId != null || ["pending", "analyzing"].includes(doc.analysisState)) result.blockedReason = "This upload is already processing or routed. Refresh to inspect its current destination.";
  if (!doc.contentFingerprint) result.blockedReason = "The source fingerprint is unavailable. Inspect the retained PDF first.";
  if (result.blockedReason) result.recovery = null;
  if (!result.recovery && !result.blockedReason) result.blockedReason = "The destination is unavailable; inspect the original intake and retained PDF before deciding how to proceed.";
  result.version = createHash("sha256").update(JSON.stringify({
    source: [doc.id, doc.contentFingerprint, doc.routingState, doc.promotedId],
    original: [canonical.id, canonical.contentFingerprint, canonical.routingState, canonical.analysisState, canonical.extractedData],
    target: target ?? null, recovery: result.recovery, blocked: result.blockedReason,
  })).digest("hex");
  return { summary: result, canonical, target, kind, parsed };
}

export async function listIntakeDuplicates(projectId: number) {
  const ctx = await context(db, projectId);
  const summaries: IntakeDuplicateSummary[] = [];
  for (const doc of ctx.docs.filter(isDuplicateCandidate)) summaries.push((await resolve(db, doc, ctx)).summary);
  return summaries;
}

/** Called INSIDE the manual promotion transaction, before any typed insert. */
export async function prepareDuplicateDraft(tx: DbTransaction, doc: ProjectIntakeDocument, version: string) {
  const ctx = await context(tx, doc.projectId, true);
  const resolved = await resolve(tx, doc, ctx);
  if (resolved.summary.version !== version || resolved.summary.recovery !== "draft" || !resolved.target) {
    throw new DuplicateRecoveryError(resolved.summary.blockedReason ?? "The duplicate changed. Refresh before recovering.");
  }
  return resolved;
}

export async function recoverIntakeDuplicate(id: number, version: string, actor: number) {
  const source = await db.query.projectIntakeDocuments.findFirst({ where: eq(projectIntakeDocuments.id, id) });
  if (!source) throw new DuplicateRecoveryError("Document not found.");
  // Repeat requests return the already committed winner, never another draft.
  const [audit] = await db.select().from(intakeManualPromotions).where(eq(intakeManualPromotions.intakeDocumentId, id));
  if (audit && data(source.extractedData).duplicateRecovery) return { projectId: source.projectId, kind: audit.promotedKind, id: audit.promotedId, replayed: true };
  const ctx = await context(db, source.projectId);
  const preview = await resolve(db, source, ctx);
  if (preview.summary.recovery === "draft" && preview.target) {
    const { promoteParkedFinancialDocument } = await import("./manual-promotion.service");
    return promoteParkedFinancialDocument({
      intakeDocumentId: id, expectedFingerprint: source.contentFingerprint,
      kind: preview.kind, contractorId: preview.target.contractorId,
      devisId: "devisId" in preview.target ? preview.target.devisId : undefined,
      note: `Explicit recovery of historical ${preview.summary.label}; original preserved.`,
      confirmedByUserId: actor, duplicateRecoveryVersion: version,
    });
  }
  return db.transaction(async tx => {
    const locked = await context(tx, source.projectId, true);
    const current = locked.docs.find(d => d.id === id);
    if (!current) throw new DuplicateRecoveryError("Document no longer exists.");
    const resolved = await resolve(tx, current, locked);
    if (resolved.summary.version !== version || resolved.summary.recovery !== "resume") {
      throw new DuplicateRecoveryError(resolved.summary.blockedReason ?? "The source changed. Refresh before recovering.");
    }
    const original = resolved.canonical;
    const [job] = await tx.select().from(intakeJobs).where(eq(intakeJobs.intakeDocumentId, original.id)).for("update");
    if (job?.state === "in_flight") throw new DuplicateRecoveryError("The original worker is still finishing. Retry recovery after it completes.");
    await tx.update(projectIntakeDocuments).set({
      analysisState: "pending", routingState: "unrouted",
      notes: `${original.notes ?? ""}\nExplicit duplicate recovery requested by user ${actor} from intake #${id}.`,
    }).where(eq(projectIntakeDocuments.id, original.id));
    await tx.insert(intakeJobs).values({ intakeDocumentId: original.id, state: "pending" })
      .onConflictDoUpdate({ target: intakeJobs.intakeDocumentId, set: {
        state: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null,
      } });
    return { projectId: source.projectId, kind: "intake", id: original.id, replayed: false };
  });
}
