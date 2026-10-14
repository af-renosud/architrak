import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { devis, projects, devisStageDecisions } from "@shared/schema";
import { canRestoreSignedStage, requiresStageReopenConfirmation } from "@shared/devis-stage-recovery";
import { getDocumentBuffer } from "../storage/object-storage";

export const stageRecoverySchema = z.object({
  action: z.enum(["restore", "reopen"]),
  expectedStage: z.string(),
  targetStage: z.enum(["received", "checked_internal", "approved_for_signing", "sent_to_client"]).optional(),
  confirmed: z.literal(true),
  reason: z.string().trim().min(10).max(2000),
}).strict();
export class StageRecoveryError extends Error {}
export async function recoverDevisStage(id: number, actorId: number, input: z.infer<typeof stageRecoverySchema>) {
  return db.transaction(async tx => {
    const [identity] = await tx.select({ projectId: devis.projectId }).from(devis).where(eq(devis.id, id));
    if (!identity) throw new StageRecoveryError("Quotation not found.");
    const [project] = await tx.select().from(projects).where(eq(projects.id, identity.projectId)).for("update");
    const [before] = await tx.select().from(devis).where(eq(devis.id, id)).for("update");
    if (!before || !project || project.archivedAt || project.status === "archived" ||
      ["void", "cancelled", "superseded"].includes(before.status) || before.accountingState === "superseded")
      throw new StageRecoveryError("Inactive quotations or archived projects cannot be changed.");
    if (before.signOffStage !== input.expectedStage)
      throw new StageRecoveryError("The workflow stage changed. Refresh before confirming again.");
    let nextStage: string;
    if (input.action === "restore") {
      if (!canRestoreSignedStage(before)) throw new StageRecoveryError("Verified existing signature provenance and a signed PDF are required.");
      let pdf: Buffer;
      try { pdf = await getDocumentBuffer(before.signedPdfStorageKey!); }
      catch { throw new StageRecoveryError("The stored signed PDF is unavailable. No status was changed."); }
      if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new StageRecoveryError("The stored signed copy is not a valid PDF.");
      nextStage = "client_signed_off";
    } else {
      if (!input.targetStage || !requiresStageReopenConfirmation(before.signOffStage, input.targetStage))
        throw new StageRecoveryError("This is not a backward transition from an approved stage.");
      nextStage = input.targetStage;
    }
    const [after] = await tx.update(devis).set({ signOffStage: nextStage, updatedAt: new Date() })
      .where(eq(devis.id, id)).returning();
    await tx.insert(devisStageDecisions).values({
      devisId: id, actorId, reason: input.reason,
      beforeState: { stage: before.signOffStage, signedPdfStorageKey: before.signedPdfStorageKey,
        signedOffVia: before.signedOffVia, manualSignoffAt: before.manualSignoffAt },
      afterState: { stage: nextStage, action: input.action, signatureEvidencePreserved: true },
    });
    return after;
  });
}
