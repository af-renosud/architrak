import { db } from "../db";
import { eq, sql } from "drizzle-orm";
import { devis, devisLineItems, devisTranslations, type Devis, type DevisLineItem, type DevisTranslation } from "@shared/schema";
import { draftFrom } from "./architect-quotation-correction";
import type { ArchitectCorrectionDraft } from "@shared/architect-quotation";
import { quotationWorkingVersion, stableQuotationDigest } from "./quotation-working-version";

export interface QuotationDecisionSnapshot {
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
    row_to_json(t) AS translation,row_to_json(b) AS baseline,row_to_json(s) AS state,p.archived_at
    FROM devis d JOIN projects p ON p.id=d.project_id
    LEFT JOIN devis_translations t ON t.devis_id=d.id
    LEFT JOIN quotation_source_baselines b ON b.devis_id=d.id
    LEFT JOIN quotation_architect_state s ON s.devis_id=d.id WHERE d.id=${id}`);
  const raw = result.rows[0] as any;
  if (!raw) return null;
  return { quotation, lines, translation, archived: !!raw.archived_at,
    baseline: raw.baseline ? { ttc: String(raw.baseline.ttc), sourceDigest: raw.baseline.source_digest, storageKey: raw.baseline.source_storage_key } : null,
    draft: draftFrom({ ...raw, lines: raw.lines ?? [] }), hasCorrection: !!raw.state };
}
export function loadQuotationDecisionSnapshot(id: number): Promise<QuotationDecisionSnapshot | null> {
  return db.transaction(tx => readQuotationDecisionSnapshot(tx, id), { isolationLevel: "repeatable read", accessMode: "read only" });
}
export function quotationDecisionVersion(s: QuotationDecisionSnapshot) {
  return stableQuotationDigest({ working: quotationWorkingVersion(s.quotation, s.lines, s.translation),
    baseline: s.baseline, draft: s.draft, hasCorrection: s.hasCorrection, archived: s.archived });
}
