import { db } from "../db";
import { eq, sql } from "drizzle-orm";
import { devis, devisLineItems, devisTranslations, type Devis, type DevisLineItem, type DevisTranslation } from "@shared/schema";
import { quotationWorkingVersion } from "./quotation-working-version";
import { readQuotationDecisionSnapshot, loadQuotationDecisionSnapshot, quotationDecisionVersion } from "./quotation-decision-snapshot";
import { evaluateQuotationDecision } from "./quotation-decision";

/** Coverage is checked before this call. Commit only the exact checked version,
 * under the same source/line/translation locks used by extraction replacement. */
export async function commitTranslationApproval(
  devisId: number,
  prepared: { quotation: Devis | undefined; lines: DevisLineItem[]; translation: DevisTranslation | undefined; decisionVersion?: string },
  actorId: number, email: string | null,
) {
  const fingerprint = quotationWorkingVersion(prepared.quotation, prepared.lines, prepared.translation);
  const initial = await loadQuotationDecisionSnapshot(devisId);
  if (!initial || quotationWorkingVersion(initial.quotation, initial.lines, initial.translation) !== fingerprint) return null;
  const expectedDecisionVersion = prepared.decisionVersion ?? quotationDecisionVersion(initial);
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
    const decisionSnapshot = await readQuotationDecisionSnapshot(tx, devisId);
    if (!decisionSnapshot || quotationDecisionVersion(decisionSnapshot) !== expectedDecisionVersion
      || !(await evaluateQuotationDecision(decisionSnapshot, "approve")).allowed) return null;
    // Explicit, version-checked human approval may append its review receipt.
    // Use the existing transaction-local architect permission only after all
    // checks; background translation writes remain protected outside this tx.
    await tx.execute(sql`SELECT set_config('renosud.architect_correction','on',true)`);
    const [updated] = await tx.update(devisTranslations).set({
      headerTranslated: { ...((translation.headerTranslated ?? {}) as object), humanReviewed: true,
        sourceReview: { version: expectedDecisionVersion, sourceDigest: decisionSnapshot.baseline?.sourceDigest ?? null,
          actorId, reviewedAt: new Date().toISOString(), kind: "explicit-review" } },
      status: "finalised", approvedAt: new Date(), approvedBy: actorId, approvedByEmail: email,
      translatedPdfStorageKey: null, combinedPdfStorageKey: null,
      contextsVersion: sql`${devisTranslations.contextsVersion} + 1`, updatedAt: new Date(),
    }).where(eq(devisTranslations.devisId, devisId)).returning();
    return updated;
  });
}