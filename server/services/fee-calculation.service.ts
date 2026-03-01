import { storage } from "../storage";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { feeEntries, fees } from "@shared/schema";
import type { InsertFeeEntry } from "@shared/schema";

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
  const updateData: Partial<InsertFeeEntry> = {
    status: "invoiced",
    dateInvoiced: today,
  };
  if (pennylaneInvoiceRef && typeof pennylaneInvoiceRef === "string" && pennylaneInvoiceRef.trim()) {
    updateData.pennylaneInvoiceRef = pennylaneInvoiceRef.trim();
  }

  const updated = await storage.updateFeeEntry(entryId, updateData);

  const siblingEntries = await storage.getFeeEntries(targetEntry.feeId);
  const invoicedTotal = siblingEntries
    .filter(e => e.status === "invoiced")
    .reduce((sum, e) => sum + parseFloat(e.feeAmount), 0);

  const feeRecords = await db.select().from(fees).where(eq(fees.id, targetEntry.feeId));
  if (feeRecords.length) {
    const fee = feeRecords[0];
    const totalFeeHt = parseFloat(fee.feeAmountHt || "0");
    await storage.updateFee(targetEntry.feeId, {
      invoicedAmount: invoicedTotal.toFixed(2),
      remainingAmount: Math.max(0, totalFeeHt - invoicedTotal).toFixed(2),
    });
  }

  return { success: true, status: 200, data: updated };
}
