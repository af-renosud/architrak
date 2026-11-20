import { db } from "../db";
import { eq, sql } from "drizzle-orm";
import { devis } from "@shared/schema";
import { readQuotationDecisionSnapshot, quotationDecisionVersion } from "./quotation-decision-snapshot";
import { evaluateQuotationDecision } from "./quotation-decision";

/** Approval-stage changes cannot validate one version and commit another.
 * No content mutations are bundled with this transition. */
export async function commitQuotationApprovalStage(id: number, expectedVersion: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM devis WHERE id=${id} FOR UPDATE`);
    await tx.execute(sql`SELECT p.id FROM projects p JOIN devis d ON d.project_id=p.id WHERE d.id=${id} FOR SHARE OF p`);
    await tx.execute(sql`SELECT id FROM devis_line_items WHERE devis_id=${id} FOR SHARE`);
    await tx.execute(sql`SELECT devis_id FROM devis_translations WHERE devis_id=${id} FOR SHARE`);
    const snapshot = await readQuotationDecisionSnapshot(tx, id);
    if (!snapshot || quotationDecisionVersion(snapshot) !== expectedVersion ||
      !(await evaluateQuotationDecision(snapshot, "advance")).allowed) return undefined;
    const [updated] = await tx.update(devis).set({ signOffStage: "approved_for_signing", updatedAt: new Date() })
      .where(eq(devis.id, id)).returning();
    return updated;
  });
}
