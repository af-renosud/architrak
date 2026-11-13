import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { db } from "../db";
import { appSettings, emailDocuments } from "@shared/schema";
import { storage } from "../storage";
import { deleteDocument } from "../storage/object-storage";

/** Delete only conclusively irrelevant, unfiled PDFs; storage revalidates under
 * row locks and protects every retained provenance consumer. */
export async function discardIrrelevantEmailDocument(id: number): Promise<boolean> {
  return !!await storage.purgeSkippedEmailDocumentAtomically(id, undefined, true);
}

export async function cleanupIrrelevantEmailDocuments(): Promise<void> {
  const rows = await db.select({ id: emailDocuments.id }).from(emailDocuments).where(and(
    isNull(emailDocuments.projectId), isNull(emailDocuments.devisId), isNull(emailDocuments.invoiceId),
    inArray(emailDocuments.extractionStatus, ["skipped", "financial_excluded", "financial_identity_review", "archived_project_candidate"]),
  ));
  for (const row of rows) {
    try { await discardIrrelevantEmailDocument(row.id); }
    catch { console.warn(`[email-cleanup] Could not remove irrelevant intake ${row.id}; will retry.`); }
  }
  // Keys only, not documents: durable deletion receipts survive storage outages.
  const pending = await db.select().from(appSettings).where(like(appSettings.key, "irrelevant_pdf_cleanup:%"));
  for (const receipt of pending) {
    try {
      const { id, storageKey } = JSON.parse(receipt.value);
      if (!await storage.isStorageKeyReferencedElsewhere(storageKey, id)) await deleteDocument(storageKey);
      await db.delete(appSettings).where(eq(appSettings.key, receipt.key));
    } catch { console.warn("[email-cleanup] Object cleanup pending; will retry."); }
  }
}
