import { storage } from "../storage";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { feeEntries, fees } from "@shared/schema";
import type { FeeEntry } from "@shared/schema";

/** Transaction handle type accepted by the tx-aware variants below. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Task #426 — transaction-aware, metadata-explicit variant of the invoiced
 * transition. Unlike the legacy route-facing `markFeeEntryInvoiced` (which
 * stamps *today*), this takes the EXTRACTED invoice date/ref so a caught
 * facture d'honoraires is recorded with the document's own issue date.
 *
 * Runs entirely on the supplied transaction: entry status flip + parent-fee
 * invoiced/remaining recompute are atomic with whatever else the caller is
 * doing (milestone transition, evidence binding, audit insert).
 *
 * Returns the updated entry, or an error string when the entry is missing /
 * not pending (caller decides whether that is a refusal or an idempotent
 * replay).
 */
export async function markFeeEntryInvoicedTx(
  tx: Tx,
  entryId: number,
  meta: {
    /** ISO yyyy-mm-dd — the EXTRACTED invoice issue date, never "today" implicitly. */
    dateInvoiced: string;
    pennylaneInvoiceRef?: string | null;
    pennylaneInvoiceNumber?: string | null;
  },
): Promise<{ ok: true; entry: FeeEntry } | { ok: false; reason: "not_found" | "not_pending"; entry?: FeeEntry }> {
  const [target] = await tx.select().from(feeEntries).where(eq(feeEntries.id, entryId));
  if (!target) return { ok: false, reason: "not_found" };
  if (target.status !== "pending") return { ok: false, reason: "not_pending", entry: target };

  const update: Record<string, unknown> = {
    status: "invoiced",
    dateInvoiced: meta.dateInvoiced,
  };
  if (meta.pennylaneInvoiceRef?.trim()) update.pennylaneInvoiceRef = meta.pennylaneInvoiceRef.trim();
  if (meta.pennylaneInvoiceNumber?.trim() && !target.pennylaneInvoiceNumber) {
    update.pennylaneInvoiceNumber = meta.pennylaneInvoiceNumber.trim();
  }
  const [updated] = await tx.update(feeEntries).set(update).where(eq(feeEntries.id, entryId)).returning();

  await recomputeFeeTotalsTx(tx, target.feeId);
  return { ok: true, entry: updated };
}

/** Recompute parent-fee invoiced/remaining from sibling entries (tx-scoped). */
export async function recomputeFeeTotalsTx(tx: Tx, feeId: number): Promise<void> {
  const siblings = await tx.select().from(feeEntries).where(eq(feeEntries.feeId, feeId));
  const invoicedTotal = siblings
    .filter((e) => e.status === "invoiced")
    .reduce((sum, e) => sum + parseFloat(e.feeAmount), 0);
  const [fee] = await tx.select().from(fees).where(eq(fees.id, feeId));
  if (fee) {
    const totalFeeHt = parseFloat(fee.feeAmountHt || "0");
    await tx
      .update(fees)
      .set({
        invoicedAmount: invoicedTotal.toFixed(2),
        remainingAmount: Math.max(0, totalFeeHt - invoicedTotal).toFixed(2),
      })
      .where(eq(fees.id, feeId));
  }
}

export async function markFeeEntryInvoiced(entryId: number, pennylaneInvoiceRef?: string) {
  const feesList = await db.select().from(feeEntries).where(eq(feeEntries.id, entryId));
  if (!feesList.length) {
    return { success: false, status: 404, data: { message: "Fee entry not found" } };
  }
  const targetEntry = feesList[0];
  if (targetEntry.status !== "pending") {
    return { success: false, status: 400, data: { message: "Entry is not in pending status" } };
  }

  const today = new Date().toISOString().split("T")[0];
  const result = await db.transaction((tx) =>
    markFeeEntryInvoicedTx(tx, entryId, { dateInvoiced: today, pennylaneInvoiceRef }),
  );
  if (!result.ok) {
    return result.reason === "not_found"
      ? { success: false, status: 404, data: { message: "Fee entry not found" } }
      : { success: false, status: 400, data: { message: "Entry is not in pending status" } };
  }
  // Keep the legacy read-back shape (storage-level entity).
  const updated = await storage.getFeeEntries(targetEntry.feeId).then((es) => es.find((e) => e.id === entryId));
  return { success: true, status: 200, data: updated ?? result.entry };
}
