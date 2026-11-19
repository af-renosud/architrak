import { db } from "../db";
import { eq, sql } from "drizzle-orm";
import { devis, devisLineItems, devisTranslations, type Devis, type DevisLineItem, type DevisTranslation } from "@shared/schema";
import { quotationWorkingVersion } from "./quotation-working-version";
import { correctedFinancialBlocker, draftFrom } from "./architect-quotation-correction";
import type { ArchitectCorrectionDraft } from "@shared/architect-quotation";

/** Coverage is checked before this call. Commit only the exact checked version,
 * under the same source/line/translation locks used by extraction replacement. */
export async function commitTranslationApproval(
  devisId: number,
  prepared: { quotation: Devis | undefined; lines: DevisLineItem[]; translation: DevisTranslation | undefined },
  actorId: number, email: string | null,
) {
  const fingerprint = quotationWorkingVersion(prepared.quotation, prepared.lines, prepared.translation);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM devis WHERE id=${devisId} FOR UPDATE`);
    const project = await tx.execute(sql`SELECT p.archived_at FROM projects p JOIN devis d ON d.project_id=p.id
      WHERE d.id=${devisId} FOR SHARE OF p`);
    if (!project.rows.length || project.rows[0].archived_at) return null;
    await tx.execute(sql`SELECT id FROM devis_line_items WHERE devis_id=${devisId} FOR UPDATE`);
    await tx.execute(sql`SELECT devis_id FROM devis_translations WHERE devis_id=${devisId} FOR UPDATE`);
    const [quotation] = await tx.select().from(devis).where(eq(devis.id, devisId));
    const lines = await tx.select().from(devisLineItems).where(eq(devisLineItems.devisId, devisId)).orderBy(devisLineItems.lineNumber);
    const [translation] = await tx.select().from(devisTranslations).where(eq(devisTranslations.devisId, devisId));
    if (!translation || !["draft", "edited"].includes(translation.status)
      || quotationWorkingVersion(quotation, lines, translation) !== fingerprint) return null;
    // Recheck a confirmed source even when no correction was ever saved.
    // Review is an explicit approval event, not a side effect of editing.
    const reviewed = await tx.execute(sql`SELECT row_to_json(d) AS quotation,
      (SELECT json_agg(l ORDER BY l.line_number,l.id) FROM devis_line_items l WHERE l.devis_id=d.id) AS lines,
      row_to_json(t) AS translation,row_to_json(b) AS baseline,row_to_json(s) AS state
      FROM devis d LEFT JOIN devis_translations t ON t.devis_id=d.id
      LEFT JOIN quotation_source_baselines b ON b.devis_id=d.id
      LEFT JOIN quotation_architect_state s ON s.devis_id=d.id WHERE d.id=${devisId}`);
    const reviewState = reviewed.rows[0] as any;
    if (reviewState?.baseline && correctedFinancialBlocker(draftFrom({ ...reviewState, lines: reviewState.lines ?? [] }),
      { ttc: String(reviewState.baseline.ttc) }, { ht: quotation.amountHt, ttc: quotation.amountTtc })) return null;
    const correction = await tx.execute(sql`SELECT s.draft,b.ttc FROM quotation_architect_state s
      LEFT JOIN quotation_source_baselines b ON b.devis_id=s.devis_id WHERE s.devis_id=${devisId}`);
    if (correction.rows.length && correction.rows[0].ttc != null) {
      const row = correction.rows[0], saved = row.draft as ArchitectCorrectionDraft;
      const working = { ...saved, lines: saved.lines.map(l => {
        const live = lines.find(r => r.id === l.id);
        return live ? { ...l, quantity: live.quantity ?? "0", unitPriceHt: live.unitPriceHt ?? "0.00", totalHt: live.totalHt } : l;
      }) };
      if (correctedFinancialBlocker(working, row.ttc == null ? null : { ttc: String(row.ttc) },
        { ht: quotation.amountHt ?? "",ttc: quotation.amountTtc ?? "" })) return null;
    }
    const [updated] = await tx.update(devisTranslations).set({
      headerTranslated: { ...((translation.headerTranslated ?? {}) as object), humanReviewed: true,
        sourceReview: { version: fingerprint, sourceDigest: reviewState?.baseline?.source_digest ?? null,
          actorId, reviewedAt: new Date().toISOString(), kind: "explicit-review" } },
      status: "finalised", approvedAt: new Date(), approvedBy: actorId, approvedByEmail: email,
      translatedPdfStorageKey: null, combinedPdfStorageKey: null,
      contextsVersion: sql`${devisTranslations.contextsVersion} + 1`, updatedAt: new Date(),
    }).where(eq(devisTranslations.devisId, devisId)).returning();
    return updated;
  });
}