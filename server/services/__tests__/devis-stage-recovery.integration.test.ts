import { it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { projects, contractors, devis, devisStageDecisions } from "@shared/schema";
import { recoverDevisStage, stageRecoverySchema } from "../devis-stage-recovery";
import * as objects from "../../storage/object-storage";
import { requiresStageReopenConfirmation, hasRecordedSignature } from "@shared/devis-stage-recovery";

it("requires explicit confirmation and recognizes retained signature evidence", () => {
  expect(stageRecoverySchema.safeParse({action:"restore",expectedStage:"approved_for_signing",reason:"Restore accidental rollback"}).success).toBe(false);
  expect(requiresStageReopenConfirmation("client_signed_off","approved_for_signing")).toBe(true);
  expect(requiresStageReopenConfirmation("approved_for_signing","received")).toBe(true);
  expect(requiresStageReopenConfirmation("received","checked_internal")).toBe(false);
  expect(hasRecordedSignature({signOffStage:"received",signedOffVia:"manual_upload",manualSignoffAt:new Date()})).toBe(true);
});

it("restores retained evidence, audits changes and rejects stale or unavailable copies", async () => {
  const rollback = new Error("rollback fixture"), original = db.transaction.bind(db);
  await expect(original(async tx => {
    const [p] = await tx.insert(projects).values({name:"Stage recovery test",code:`SR-${Date.now()}`,clientName:"Test"}).returning();
    const [c] = await tx.insert(contractors).values({name:"Stage recovery contractor"}).returning();
    const signedAt = new Date("2026-10-14T10:18:49Z");
    const [d] = await tx.insert(devis).values({projectId:p.id,contractorId:c.id,devisCode:"PB.2.TEST",
      descriptionFr:"Test",amountHt:"4800",amountTtc:"5760",accountingState:"active",signOffStage:"approved_for_signing",
      signedOffVia:"manual_upload",manualSignoffAt:signedAt,signedPdfStorageKey:"/test/signed.pdf"}).returning();
    vi.spyOn(db,"transaction").mockImplementation((fn:any) => fn(tx));
    const pdf = vi.spyOn(objects,"getDocumentBuffer").mockResolvedValue(Buffer.from("%PDF-1.4\nfixture"));
    const request = {action:"restore" as const,expectedStage:"approved_for_signing",confirmed:true as const,reason:"Restore after accidental backward click"};
    try {
      const restored = await recoverDevisStage(d.id,1,request);
      expect(restored).toMatchObject({signOffStage:"client_signed_off",signedOffVia:"manual_upload",
        signedPdfStorageKey:d.signedPdfStorageKey,manualSignoffAt:signedAt});
      await expect(recoverDevisStage(d.id,1,request)).rejects.toThrow("stage changed");
      await recoverDevisStage(d.id,1,{action:"reopen",expectedStage:"client_signed_off",targetStage:"received",confirmed:true,reason:"Reopen internal review intentionally"});
      pdf.mockRejectedValueOnce(new Error("missing"));
      await expect(recoverDevisStage(d.id,1,{...request,expectedStage:"received"})).rejects.toThrow("unavailable");
      expect(await tx.select().from(devisStageDecisions).where(eq(devisStageDecisions.devisId,d.id))).toHaveLength(2);
      await tx.update(projects).set({archivedAt:new Date()}).where(eq(projects.id,p.id));
      await expect(recoverDevisStage(d.id,1,{...request,expectedStage:"received"})).rejects.toThrow("archived");
    } finally { vi.restoreAllMocks(); }
    throw rollback;
  })).rejects.toBe(rollback);
},30000);
