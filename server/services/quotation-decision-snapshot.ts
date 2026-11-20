import { db } from "../db";
import { eq, inArray, sql } from "drizzle-orm";
import { devis, devisLineItems, devisTranslations, type Devis, type DevisLineItem, type DevisTranslation } from "@shared/schema";
import { draftFrom } from "./architect-quotation-correction";
import type { ArchitectCorrectionDraft } from "@shared/architect-quotation";
import { quotationWorkingVersion, stableQuotationDigest } from "./quotation-working-version";

export interface QuotationDecisionSnapshot {
  translationVerificationFingerprints?: string[];
  quotation: Devis;
  lines: DevisLineItem[];
  translation: DevisTranslation | undefined;
  archived: boolean;
  baseline: { ttc: string; sourceDigest: string; storageKey: string } | null;
  draft: ArchitectCorrectionDraft;
  hasCorrection: boolean;
}
type Reader = Pick<typeof db, "select" | "execute">;
/** Caller supplies a repeatable-read transaction or the locked approval transaction. */
export async function readQuotationDecisionSnapshot(tx: Reader, id: number): Promise<QuotationDecisionSnapshot | null> {
  const [quotation] = await tx.select().from(devis).where(eq(devis.id, id));
  if (!quotation) return null;
  const lines = await tx.select().from(devisLineItems).where(eq(devisLineItems.devisId, id)).orderBy(devisLineItems.lineNumber);
  const [translation] = await tx.select().from(devisTranslations).where(eq(devisTranslations.devisId, id));
  const result = await tx.execute(sql`SELECT row_to_json(d) AS quotation,
    (SELECT json_agg(l ORDER BY l.line_number,l.id) FROM devis_line_items l WHERE l.devis_id=d.id) AS lines,
    row_to_json(t) AS translation,row_to_json(b) AS baseline,row_to_json(s) AS state,p.archived_at,p.status AS project_status,
    (SELECT json_agg(e.snapshot->>'fingerprint') FROM quotation_extraction_events e
      WHERE e.devis_id=d.id AND e.outcome='translation_verified') AS translation_receipts
    FROM devis d JOIN projects p ON p.id=d.project_id
    LEFT JOIN devis_translations t ON t.devis_id=d.id
    LEFT JOIN quotation_source_baselines b ON b.devis_id=d.id
    LEFT JOIN quotation_architect_state s ON s.devis_id=d.id WHERE d.id=${id}`);
  const raw = result.rows[0] as any;
  if (!raw) return null;
  return { quotation, lines, translation, translationVerificationFingerprints: raw.translation_receipts ?? [],
    archived: !!raw.archived_at || raw.project_status === "archived",
    baseline: raw.baseline ? { ttc: String(raw.baseline.ttc), sourceDigest: raw.baseline.source_digest, storageKey: raw.baseline.source_storage_key } : null,
    draft: draftFrom({ ...raw, lines: raw.lines ?? [] }), hasCorrection: !!raw.state };
}
export function loadQuotationDecisionSnapshot(id: number): Promise<QuotationDecisionSnapshot | null> {
  return db.transaction(tx => readQuotationDecisionSnapshot(tx, id), { isolationLevel: "repeatable read", accessMode: "read only" });
}
/** Database-only list projection. Never download every original PDF on a page refresh. */
export function loadProjectQuotationDecisionSnapshots(projectId: number): Promise<Map<number, QuotationDecisionSnapshot>> {
  return db.transaction(async tx => {
    const quotations = await tx.select().from(devis).where(eq(devis.projectId, projectId));
    if (!quotations.length) return new Map();
    const ids = quotations.map(d => d.id);
    const lines = await tx.select().from(devisLineItems).where(inArray(devisLineItems.devisId, ids)).orderBy(devisLineItems.lineNumber);
    const translations = await tx.select().from(devisTranslations).where(inArray(devisTranslations.devisId, ids));
    const metadata = await tx.execute(sql`SELECT d.id,row_to_json(d) AS quotation,
      row_to_json(t) AS translation,row_to_json(b) AS baseline,row_to_json(s) AS state,
      p.archived_at,p.status AS project_status,
      (SELECT json_agg(e.snapshot->>'fingerprint') FROM quotation_extraction_events e
        WHERE e.devis_id=d.id AND e.outcome='translation_verified') AS translation_receipts,
      (SELECT json_agg(l ORDER BY l.line_number,l.id) FROM devis_line_items l WHERE l.devis_id=d.id) AS lines
      FROM devis d JOIN projects p ON p.id=d.project_id
      LEFT JOIN devis_translations t ON t.devis_id=d.id
      LEFT JOIN quotation_source_baselines b ON b.devis_id=d.id
      LEFT JOIN quotation_architect_state s ON s.devis_id=d.id WHERE d.project_id=${projectId}`);
    const result = new Map<number, QuotationDecisionSnapshot>();
    for (const quotation of quotations) {
      const raw = metadata.rows.find(r => Number(r.id) === quotation.id) as any;
      if (!raw) continue;
      result.set(quotation.id, { quotation, lines: lines.filter(l => l.devisId === quotation.id),
        translation: translations.find(t => t.devisId === quotation.id), translationVerificationFingerprints: raw.translation_receipts ?? [],
        archived: !!raw.archived_at || raw.project_status === "archived",
        baseline: raw.baseline ? { ttc: String(raw.baseline.ttc), sourceDigest: raw.baseline.source_digest, storageKey: raw.baseline.source_storage_key } : null,
        draft: draftFrom({ ...raw, lines: raw.lines ?? [] }), hasCorrection: !!raw.state });
    }
    return result;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
export function quotationDecisionVersion(s: QuotationDecisionSnapshot) {
  return stableQuotationDigest({ working: quotationWorkingVersion(s.quotation, s.lines, s.translation),
    baseline: s.baseline, draft: s.draft, hasCorrection: s.hasCorrection, archived: s.archived,
    translationReceipts: [...(s.translationVerificationFingerprints ?? [])].sort() });
}
/** Stable while PDF cache/envelope transport metadata is being persisted.
 * Authored content, context version and source evidence must not change. */
export function quotationPackageVersion(s: QuotationDecisionSnapshot) {
  const d = s.quotation, t = s.translation;
  return stableQuotationDigest({
    quotation: Object.fromEntries(Object.entries(d).filter(([key]) => !key.startsWith("archisign") && key !== "updatedAt")),
    lines: s.lines, baseline: s.baseline, draft: s.draft, archived: s.archived, hasCorrection: s.hasCorrection,
    translation: t ? { status: t.status, header: t.headerTranslated, lines: t.lineTranslations,
      contextsVersion: t.contextsVersion, approvedAt: t.approvedAt, approvedBy: t.approvedBy } : null,
  });
}
