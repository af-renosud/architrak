import { createHash, randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import type { DbTransaction } from "../storage";
import {
  devis, devisLineItems, devisLineContexts, devisLineContextAssets, devisTranslations,
  devisSupportingPdfs, devisReplacements, projects, quotationArchitectAudit,
  devisTranslationLineSchema, type Devis, type DevisTranslationLine,
} from "@shared/schema";
import { carryForwardSchema, carrySetupKeys, type CarryForwardPreview, type CarryForwardSelection, type CarryLine } from "@shared/quotation-carry-forward";
import { collectContextAssetIds, contextDocSchema, isContextDocEmpty } from "@shared/context-doc";
import { composeDevisCode, tryParseDevisCode } from "@shared/devis-code";
import { getDocumentBuffer, uploadDocument, deleteDocument } from "../storage/object-storage";
import { ReplacementError, replacementBlockedReason, REPLACEMENT_LOCK_NAMESPACE } from "./quotation-replacement.service";

type Connection = typeof db | DbTransaction;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const translations = (value: unknown): DevisTranslationLine[] => {
  const result = devisTranslationLineSchema.array().safeParse(value ?? []);
  if (!result.success) throw new ReplacementError(409, "INVALID_TRANSLATION", "Stored translation content needs review before it can be copied.");
  return result.data;
};
const textHeader = (value: unknown) => {
  const h = (value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(["description", "descriptionExplanation", "descriptionExplanationFr", "summary"]
    .filter(key => typeof h[key] === "string" && (h[key] as string).trim()).map(key => [key, h[key] as string]));
};

/** Line numbers are deliberately NOT an identity. Repeated descriptions are not auto-matched. */
export function suggestCarryMatches(source: CarryLine[], target: CarryLine[]): CarryLine[] {
  const key = (line: CarryLine) => JSON.stringify([
    normalize(line.description), line.quantity ? Number(line.quantity) : null,
    normalize(line.unit ?? ""), line.unitPriceHt ? Number(line.unitPriceHt) : null, Number(line.totalHt),
  ]);
  return source.map(line => {
    const same = target.filter(t => key(t) === key(line));
    return { ...line, suggestedTargetId: same.length === 1 && source.filter(s => key(s) === key(line)).length === 1 ? same[0].id : null };
  });
}

async function loadState(conn: Connection, sourceId: number, targetId: number, lock = false) {
  const ids = [sourceId, targetId].sort((a, b) => a - b);
  const quotes = await conn.select().from(devis).where(inArray(devis.id, ids)).orderBy(asc(devis.id));
  const source = quotes.find(q => q.id === sourceId);
  const target = quotes.find(q => q.id === targetId);
  if (!source || !target || source.id === target.id || source.projectId !== target.projectId) {
    throw new ReplacementError(400, "INVALID_TARGET", "Choose a different quotation in the same project.");
  }
  // Translation is the existing context/finalisation mutex. Parent quotation
  // locks (held by callers) also prevent concurrent child inserts via FK checks.
  const tq = conn.select().from(devisTranslations).where(inArray(devisTranslations.devisId, ids)).orderBy(asc(devisTranslations.devisId));
  const tr = await (lock ? tq.for("update") : tq);
  const lq = conn.select().from(devisLineItems).where(inArray(devisLineItems.devisId, ids)).orderBy(asc(devisLineItems.id));
  const lines = await (lock ? lq.for("update") : lq);
  const cq = conn.select().from(devisLineContexts).where(inArray(devisLineContexts.devisId, ids)).orderBy(asc(devisLineContexts.id));
  const contexts = await (lock ? cq.for("update") : cq);
  const aq = conn.select().from(devisLineContextAssets).where(inArray(devisLineContextAssets.devisId, ids)).orderBy(asc(devisLineContextAssets.id));
  const assets = await (lock ? aq.for("update") : aq);
  const pq = conn.select().from(devisSupportingPdfs).where(inArray(devisSupportingPdfs.devisId, ids)).orderBy(asc(devisSupportingPdfs.id));
  const pdfs = await (lock ? pq.for("update") : pq);
  const [project] = await conn.select().from(projects).where(eq(projects.id, source.projectId));
  const commitment = await conn.execute(sql`SELECT
    EXISTS(SELECT 1 FROM invoices WHERE devis_id=${targetId})
    OR EXISTS(SELECT 1 FROM situations WHERE devis_id=${targetId})
    OR EXISTS(SELECT 1 FROM certificats WHERE acompte_devis_id=${targetId})
    OR EXISTS(SELECT 1 FROM acompte_no_invoice_payments WHERE devis_id=${targetId})
    AS committed`);
  const parsed = tryParseDevisCode(source.devisCode);
  let code = source.devisCode;
  let sequence: number | null = null;
  if (source.lotRefText && parsed) {
    const max = await conn.execute(sql`SELECT COALESCE(MAX(lot_sequence),0)+1 AS next FROM devis
      WHERE project_id=${source.projectId} AND lower(lot_ref_text)=lower(${source.lotRefText})`);
    sequence = Number(max.rows[0].next);
    code = composeDevisCode({ ...parsed, lotRef: source.lotRefText, lotSequence: sequence });
  }
  return { source, target, tr, lines, contexts, assets, pdfs, project, code, sequence, committed: !!commitment.rows[0]?.committed };
}
type State = Awaited<ReturnType<typeof loadState>>;
const version = (s: State) => hash(s);
function blocked(s: State) {
  if (s.project?.archivedAt || s.project?.status === "archived") return "Archived projects are read-only.";
  if (s.target.signedPdfStorageKey || s.target.status === "signed" || s.target.signOffStage === "client_signed_off"
    || s.target.archisignEnvelopeStatus === "signed") return "The replacement is already signed. Its content cannot be changed.";
  const reason = replacementBlockedReason(s.target);
  if (reason) return reason;
  const status = s.tr.find(t => t.devisId === s.target.id)?.status;
  if (status === "finalised") return "Reopen the replacement translation for editing before carrying work forward.";
  if (status === "processing") return "Wait for the replacement translation to finish before copying previous work.";
  if (s.tr.find(t => t.devisId === s.source.id)?.status === "processing") return "Wait for the previous translation to finish before copying work.";
  return null;
}
function lineViews(s: State, id: number): CarryLine[] {
  const translated = translations(s.tr.find(t => t.devisId === id)?.lineTranslations);
  return s.lines.filter(l => l.devisId === id).map(line => {
    const raw = s.contexts.find(c => c.devisLineItemId === line.id)?.document;
    const doc = raw ? contextDocSchema.parse(raw) : null;
    const candidates = translated.filter(t => t.lineNumber === line.lineNumber);
    const t = candidates.length === 1 ? candidates[0] : undefined;
    // Do not offer an obsolete translation tied to different source wording.
    const translation = t && (id === s.target.id || normalize(t.originalDescription) === normalize(line.description)) ? t.translation : null;
    return {
      id: line.id, lineNumber: line.lineNumber, description: line.description,
      quantity: line.quantity ?? "", unit: line.unit, unitPriceHt: line.unitPriceHt ?? "", totalHt: line.totalHt,
      translation: translation?.trim() ? translation : null,
      context: isContextDocEmpty(doc) ? null : doc, imageCount: doc ? collectContextAssetIds(doc).length : 0,
      suggestedTargetId: null,
    };
  });
}
const labels: Record<typeof carrySetupKeys[number], string> = {
  descriptionUk: "English works description", descriptionFr: "Working quotation description",
  ref2: "Secondary reference", lotId: "Project lot", devisCode: "Internal code / name (next sequence if structured)",
  feePercentageOverride: "Fee percentage override — confirm applicability",
  invoicingMode: "Invoicing mode — confirm applicability", marcheId: "Contract association — confirm applicability",
};
function preview(s: State): CarryForwardPreview {
  const sourceHeader = textHeader(s.tr.find(t => t.devisId === s.source.id)?.headerTranslated);
  const targetHeader = textHeader(s.tr.find(t => t.devisId === s.target.id)?.headerTranslated);
  const targetLines = lineViews(s, s.target.id);
  return {
    sourceId: s.source.id, targetId: s.target.id, version: version(s), blockedReason: blocked(s),
    setup: carrySetupKeys.map(key => ({
      key, label: labels[key], from: String(key === "devisCode" ? s.code : s.source[key] ?? ""),
      to: String(s.target[key] ?? ""), available: s.source[key] != null && s.source[key] !== ""
        && (key !== "devisCode" || !s.sequence || s.sequence <= 9999)
        && (!["marcheId", "feePercentageOverride", "invoicingMode"].includes(key) || (!s.committed && s.source.contractorId === s.target.contractorId)),
    })),
    sourceLines: suggestCarryMatches(lineViews(s, s.source.id), targetLines), targetLines,
    header: { source: Object.values(sourceHeader).join("\n\n"), target: Object.values(targetHeader).join("\n\n"),
      available: Object.keys(sourceHeader).length > 0 && Object.keys(targetHeader).length === 0 },
    supportingPdfs: s.pdfs.filter(p => p.devisId === s.source.id).map(p => ({
      id: p.id, label: p.label, fileName: p.fileName,
      alreadyPresent: s.pdfs.some(t => t.devisId === s.target.id && t.fileName === p.fileName),
    })),
  };
}
export async function getCarryForwardPreview(sourceId: number, targetId: number) {
  return preview(await loadState(db, sourceId, targetId));
}

export async function cleanupCarryObjects(keys: string[]) {
  for (const key of keys) {
    try {
      // A commit acknowledgement may be lost even though the transaction
      // committed. Never remove bytes that a committed copy now references.
      const used = await db.execute(sql`SELECT
        EXISTS(SELECT 1 FROM devis_line_context_assets WHERE storage_key=${key})
        OR EXISTS(SELECT 1 FROM devis_supporting_pdfs WHERE storage_key=${key}) AS retained`);
      if (!used.rows[0]?.retained) await deleteDocument(key);
    }
    catch { console.error("[CarryForward] Rolled-back object cleanup failed; retained unreferenced copy."); }
  }
}

/** Called inside replacement's transaction, or the recovery transaction below. */
export async function applyCarryForward(tx: DbTransaction, source: Devis, target: Devis,
  input: CarryForwardSelection, actorId: number, uploaded: string[]) {
  const selection = carryForwardSchema.parse(input);
  const s = await loadState(tx, source.id, target.id, true);
  if (version(s) !== selection.version) throw new ReplacementError(409, "STALE_CARRY_FORWARD", "Previous or replacement content changed. Reload and review what to retain.");
  const reason = blocked(s);
  if (reason) throw new ReplacementError(409, "CARRY_FORWARD_BLOCKED", reason);
  const p = preview(s);
  const usedSource = new Set<number>(), usedTarget = new Set<number>();
  for (const map of selection.lines) {
    if (usedSource.has(map.sourceLineId) || usedTarget.has(map.targetLineId)) throw new ReplacementError(400, "DUPLICATE_MAPPING", "Map each previous and replacement line only once.");
    usedSource.add(map.sourceLineId); usedTarget.add(map.targetLineId);
    const from = p.sourceLines.find(l => l.id === map.sourceLineId);
    const to = p.targetLines.find(l => l.id === map.targetLineId);
    if (!from || !to || (!map.context && !map.translation)) throw new ReplacementError(400, "INVALID_MAPPING", "Select existing lines and content to copy.");
    if (map.translation && (p.sourceLines.filter(l => l.lineNumber === from.lineNumber).length !== 1
      || p.targetLines.filter(l => l.lineNumber === to.lineNumber).length !== 1)) {
      throw new ReplacementError(409, "AMBIGUOUS_LINE_NUMBER", "Resolve duplicate line numbers before copying translations. Context images can still be assigned by line.");
    }
    const targetTranslation = translations(s.tr.find(t => t.devisId === target.id)?.lineTranslations)
      .find(t => t.lineNumber === to.lineNumber);
    if ((map.context && (!from.context || to.context))
      || (map.translation && (!from.translation || targetTranslation?.translation?.trim()))) {
      throw new ReplacementError(409, "EXISTING_CONTENT", "Existing replacement work will not be overwritten. Review the selected line content.");
    }
  }
  for (const key of selection.setup) {
    if (!p.setup.find(f => f.key === key)?.available) throw new ReplacementError(400, "INVALID_SETUP", "Selected setup cannot be carried forward.");
  }
  if (selection.header && !p.header.available) throw new ReplacementError(409, "EXISTING_HEADER", "The replacement already has a document overview. It will not be overwritten.");
  const selectedPdfs = Array.from(new Set(selection.supportingPdfIds)).map(id => {
    const item = p.supportingPdfs.find(pdf => pdf.id === id);
    if (!item || item.alreadyPresent) throw new ReplacementError(409, "EXISTING_ATTACHMENT", "Review the supporting PDFs; an attachment is missing or already present.");
    return s.pdfs.find(pdf => pdf.id === id)!;
  });
  if (!selection.lines.length && !selection.setup.length && !selection.header && !selectedPdfs.length) return { copiedLines: 0 };

  async function copyObject(key: string, name: string, mime: string) {
    const buffer = await getDocumentBuffer(key);
    if (!buffer.length) throw new ReplacementError(409, "MISSING_ASSET", "A previous attachment is empty. No replacement or partial copy was saved.");
    const copied = await uploadDocument(source.projectId, `carry-${randomUUID()}-${name}`, buffer, mime);
    uploaded.push(copied);
    return copied;
  }
  const targetTr = s.tr.find(t => t.devisId === target.id);
  const newTranslations = translations(targetTr?.lineTranslations);
  for (const map of selection.lines) {
    const from = p.sourceLines.find(l => l.id === map.sourceLineId)!;
    const to = p.targetLines.find(l => l.id === map.targetLineId)!;
    if (map.context && from.context) {
      const document = structuredClone(from.context);
      const ids = collectContextAssetIds(document);
      const remap = new Map<number, number>();
      for (const id of ids) {
        const asset = s.assets.find(a => a.id === id && a.devisId === source.id && a.devisLineItemId === from.id);
        if (!asset) throw new ReplacementError(409, "MISSING_ASSET", "A previous context image is unavailable. No partial copy was saved.");
        const storageKey = await copyObject(asset.storageKey, "context-image", asset.mimeType);
        const [created] = await tx.insert(devisLineContextAssets).values({
          devisId: target.id, devisLineItemId: to.id, storageKey, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes,
        }).returning();
        remap.set(id, created.id);
      }
      for (const node of document.content) if (node.type === "image") node.attrs.assetId = remap.get(node.attrs.assetId)!;
      const existing = s.contexts.find(c => c.devisLineItemId === to.id);
      if (existing) await tx.update(devisLineContexts).set({ document, revision: existing.revision + 1, updatedAt: new Date() }).where(eq(devisLineContexts.id, existing.id));
      else await tx.insert(devisLineContexts).values({ devisId: target.id, devisLineItemId: to.id, document });
    }
    if (map.translation) {
      const original = translations(s.tr.find(t => t.devisId === source.id)?.lineTranslations).find(t => t.lineNumber === from.lineNumber)!;
      const existing = newTranslations.find(t => t.lineNumber === to.lineNumber);
      const entry: DevisTranslationLine = {
        ...existing, lineNumber: to.lineNumber, originalDescription: to.description,
        translation: original.translation, explanation: original.explanation, explanationFr: original.explanationFr, edited: true,
      };
      if (existing) newTranslations.splice(newTranslations.indexOf(existing), 1, entry);
      else newTranslations.push(entry);
    }
  }
  let position = Math.max(0, ...s.pdfs.filter(pdf => pdf.devisId === target.id).map(pdf => pdf.position));
  for (const pdf of selectedPdfs) {
    const storageKey = await copyObject(pdf.storageKey, pdf.fileName, "application/pdf");
    await tx.insert(devisSupportingPdfs).values({
      devisId: target.id, label: pdf.label, fileName: pdf.fileName, storageKey,
      pageCount: pdf.pageCount, byteSize: pdf.byteSize, position: ++position,
    });
  }
  const updates: Partial<typeof devis.$inferInsert> = { updatedAt: new Date(), signOffStage: "received" };
  for (const key of selection.setup) Object.assign(updates, { [key]: source[key] });
  if (selection.setup.includes("devisCode")) Object.assign(updates, {
    devisCode: s.code, lotRefText: source.lotRefText, lotCatalogId: source.lotCatalogId, lotSequence: s.sequence,
  });
  await tx.update(devis).set(updates).where(eq(devis.id, target.id));
  const translationUpdate = {
    status: "draft", lineTranslations: newTranslations,
    headerTranslated: selection.header ? textHeader(s.tr.find(t => t.devisId === source.id)?.headerTranslated)
      : { ...((targetTr?.headerTranslated ?? {}) as object), humanReviewed: false },
    approvedAt: null, approvedBy: null, approvedByEmail: null,
    translatedPdfStorageKey: null, combinedPdfStorageKey: null, updatedAt: new Date(),
  };
  await tx.insert(devisTranslations).values({ devisId: target.id, ...translationUpdate, contextsVersion: 1 })
    .onConflictDoUpdate({ target: devisTranslations.devisId, set: {
      ...translationUpdate, contextsVersion: sql`${devisTranslations.contextsVersion} + 1`,
    } });
  await tx.insert(quotationArchitectAudit).values({
    devisId: target.id, actorId, operation: "correction",
    beforeSnapshot: { kind: "carry_forward", sourceDevisId: source.id, version: selection.version },
    afterSnapshot: { kind: "carry_forward", sourceDevisId: source.id, selection, reviewRequired: true },
  });
  return { copiedLines: selection.lines.length };
}

/** Later recovery is restricted to the explicit, recorded replacement liaison. */
export async function recoverCarryForward(sourceId: number, targetId: number, input: CarryForwardSelection, actorId: number) {
  const uploaded: string[] = [];
  try {
    return await db.transaction(async tx => {
      for (const id of [sourceId, targetId].sort((a, b) => a - b)) {
        const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${REPLACEMENT_LOCK_NAMESPACE}, ${id}) AS acquired`);
        if (!result.rows[0]?.acquired) throw new ReplacementError(409, "QUOTATION_BUSY", "A signing or replacement action is in progress.");
      }
      const [initial] = await tx.select().from(devis).where(eq(devis.id, sourceId));
      if (!initial) throw new ReplacementError(404, "NOT_FOUND", "Previous quotation not found.");
      await tx.select().from(projects).where(eq(projects.id, initial.projectId)).for("update");
      const rows = await tx.select().from(devis).where(inArray(devis.id, [sourceId, targetId])).orderBy(asc(devis.id)).for("update");
      const links = await tx.select().from(devisReplacements).where(eq(devisReplacements.oldDevisId, sourceId));
      if (!links.some(link => link.newDevisId === targetId)) throw new ReplacementError(400, "NOT_REPLACEMENT", "These quotations do not have a recorded replacement relationship.");
      return applyCarryForward(tx, rows.find(r => r.id === sourceId)!, rows.find(r => r.id === targetId)!, input, actorId, uploaded);
    });
  } catch (error) {
    await cleanupCarryObjects(uploaded);
    throw error;
  }
}
