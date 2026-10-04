import { db } from "../db";
import { eq, sql } from "drizzle-orm";
import { devis, devisLineItems, devisTranslations, type Devis, type DevisLineItem, type DevisTranslation } from "@shared/schema";
import { quotationWorkingVersion } from "./quotation-working-version";

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
    await tx.execute(sql`SELECT id FROM devis_line_items WHERE devis_id=${devisId} FOR UPDATE`);
    await tx.execute(sql`SELECT devis_id FROM devis_translations WHERE devis_id=${devisId} FOR UPDATE`);
    const [quotation] = await tx.select().from(devis).where(eq(devis.id, devisId));
    const lines = await tx.select().from(devisLineItems).where(eq(devisLineItems.devisId, devisId)).orderBy(devisLineItems.lineNumber);
    const [translation] = await tx.select().from(devisTranslations).where(eq(devisTranslations.devisId, devisId));
    if (!translation || !["draft", "edited"].includes(translation.status)
      || quotationWorkingVersion(quotation, lines, translation) !== fingerprint) return null;
    const [updated] = await tx.update(devisTranslations).set({
      status: "finalised", approvedAt: new Date(), approvedBy: actorId, approvedByEmail: email,
      translatedPdfStorageKey: null, combinedPdfStorageKey: null,
      contextsVersion: sql`${devisTranslations.contextsVersion} + 1`, updatedAt: new Date(),
    }).where(eq(devisTranslations.devisId, devisId)).returning();
    return updated;
  });
}