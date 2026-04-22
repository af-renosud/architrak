import { db } from "../db";
import { eq, and, sql } from "drizzle-orm";
import { storage } from "../storage";
import { invoices, fees, feeEntries } from "@shared/schema";

export async function approveInvoice(invoiceId: number) {
  return await db.transaction(async (tx) => {
    // Pessimistic lock on the invoice row to serialize concurrent approvals.
    await tx.execute(sql`SELECT 1 FROM invoices WHERE id = ${invoiceId} FOR UPDATE`);

    const [locked] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!locked) {
      return { success: false, status: 404, data: { message: "Invoice not found" } };
    }
    if (locked.status !== "pending") {
      const alreadyApproved = locked.status === "approved";
      return {
        success: alreadyApproved,
        status: alreadyApproved ? 200 : 400,
        data: alreadyApproved
          ? { invoice: locked, feeEntry: null, fee: null, commissionAmount: 0, idempotent: true }
          : { message: `Invoice is already ${locked.status}, cannot approve` },
      };
    }

    const project = await storage.getProject(locked.projectId);
    if (!project) {
      return { success: false, status: 404, data: { message: "Project not found" } };
    }

    const feeRate = parseFloat(project.feePercentage ?? "0");

    const [updatedInvoice] = await tx
      .update(invoices)
      .set({ status: "approved" })
      .where(eq(invoices.id, invoiceId))
      .returning();

    let feeEntry = null;
    let updatedFee = null;

    if (feeRate > 0) {
      let [fee] = await tx
        .select()
        .from(fees)
        .where(and(eq(fees.projectId, locked.projectId), eq(fees.feeType, "works_percentage")));

      if (!fee) {
        [fee] = await tx
          .insert(fees)
          .values({
            projectId: locked.projectId,
            feeType: "works_percentage",
            baseAmountHt: "0.00",
            feeRate: String(feeRate),
            feeAmountHt: "0.00",
            invoicedAmount: "0.00",
            remainingAmount: "0.00",
            pennylaneRef: null,
            status: "active",
          })
          .returning();
      }

      const invoiceHt = parseFloat(locked.amountHt);
      const entryFeeAmount = parseFloat((invoiceHt * feeRate / 100).toFixed(2));

      try {
        [feeEntry] = await tx
          .insert(feeEntries)
          .values({
            feeId: fee.id,
            invoiceId: invoiceId,
            devisId: locked.devisId,
            baseHt: locked.amountHt,
            feeRate: String(feeRate),
            feeAmount: String(entryFeeAmount),
            pennylaneInvoiceRef: null,
            dateInvoiced: locked.dateIssued || new Date().toISOString().split("T")[0],
            status: "pending",
          })
          .returning();
      } catch (insErr: unknown) {
        const errCode = (insErr as { code?: string } | null)?.code;
        const errMessage = (insErr as { message?: string } | null)?.message ?? "";
        if (errCode === "23505" || /unique/i.test(String(errMessage))) {
          // Idempotency guard: a fee_entry for this invoice already exists.
          // Return success with the existing entry so retries are safe.
          const [existing] = await tx
            .select()
            .from(feeEntries)
            .where(eq(feeEntries.invoiceId, invoiceId));
          feeEntry = existing ?? null;
        } else {
          throw insErr;
        }
      }

      const allEntries = await tx.select().from(feeEntries).where(eq(feeEntries.feeId, fee.id));
      const totalBaseHt = allEntries.reduce((s, e) => s + parseFloat(e.baseHt), 0);
      const totalFeeAmount = allEntries.reduce((s, e) => s + parseFloat(e.feeAmount), 0);

      // Architect fees are HT-only (commission % × works HT). No TTC stored.
      [updatedFee] = await tx
        .update(fees)
        .set({
          baseAmountHt: totalBaseHt.toFixed(2),
          feeRate: String(feeRate),
          feeAmountHt: totalFeeAmount.toFixed(2),
          remainingAmount: totalFeeAmount.toFixed(2),
        })
        .where(eq(fees.id, fee.id))
        .returning();
    }

    return {
      success: true,
      status: 200,
      data: {
        invoice: updatedInvoice,
        feeEntry,
        fee: updatedFee,
        commissionAmount: feeEntry ? parseFloat(feeEntry.feeAmount) : 0,
      },
    };
  });
}
