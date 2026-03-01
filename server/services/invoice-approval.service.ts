import { storage } from "../storage";

export async function approveInvoice(invoiceId: number) {
  const inv = await storage.getInvoice(invoiceId);
  if (!inv) {
    return { success: false, status: 404, data: { message: "Invoice not found" } };
  }
  if (inv.status !== "pending") {
    return { success: false, status: 400, data: { message: `Invoice is already ${inv.status}, cannot approve` } };
  }

  const project = await storage.getProject(inv.projectId);
  if (!project) {
    return { success: false, status: 404, data: { message: "Project not found" } };
  }

  const feeRate = parseFloat(project.feePercentage ?? "0");
  const tvaRate = parseFloat(project.tvaRate) || 20;

  const updatedInvoice = await storage.updateInvoice(invoiceId, { status: "approved" });

  let feeEntry = null;
  let updatedFee = null;

  if (feeRate > 0) {
    let existingFees = await storage.getFeesByProject(inv.projectId);
    let fee = existingFees.find(f => f.feeType === "works_percentage");

    if (!fee) {
      fee = await storage.createFee({
        projectId: inv.projectId,
        feeType: "works_percentage",
        baseAmountHt: "0.00",
        feeRate: String(feeRate),
        feeAmountHt: "0.00",
        feeAmountTtc: "0.00",
        invoicedAmount: "0.00",
        remainingAmount: "0.00",
        pennylaneRef: null,
        status: "active",
      });
    }

    const invoiceHt = parseFloat(inv.amountHt);
    const entryFeeAmount = parseFloat((invoiceHt * feeRate / 100).toFixed(2));

    feeEntry = await storage.createFeeEntry({
      feeId: fee.id,
      invoiceId: inv.id,
      devisId: inv.devisId,
      baseHt: inv.amountHt,
      feeRate: String(feeRate),
      feeAmount: String(entryFeeAmount),
      pennylaneInvoiceRef: null,
      dateInvoiced: inv.dateIssued || new Date().toISOString().split("T")[0],
      status: "pending",
    });

    const allEntries = await storage.getFeeEntries(fee.id);
    const totalBaseHt = allEntries.reduce((s, e) => s + parseFloat(e.baseHt), 0);
    const totalFeeAmount = allEntries.reduce((s, e) => s + parseFloat(e.feeAmount), 0);
    const totalFeeAmountTtc = parseFloat((totalFeeAmount * (1 + tvaRate / 100)).toFixed(2));

    updatedFee = await storage.updateFee(fee.id, {
      baseAmountHt: String(totalBaseHt.toFixed(2)),
      feeRate: String(feeRate),
      feeAmountHt: String(totalFeeAmount.toFixed(2)),
      feeAmountTtc: String(totalFeeAmountTtc.toFixed(2)),
      remainingAmount: String(totalFeeAmount.toFixed(2)),
    });
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
}
