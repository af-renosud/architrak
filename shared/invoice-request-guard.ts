import { resolveOpeningDeposit, openingDepositEvidence, type DepositDocument } from "./invoice-deposit";

export function invoiceRequestEvidenceKey(source: unknown): string {
  const clean = { ...(source as Record<string, unknown> ?? {}) };
  delete clean._requestResolution;
  function canonical(value: any): any {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  return JSON.stringify(canonical(clean));
}

/** Evaluate stored source evidence separately from the editable economic amounts. */
export function invoiceRequestConflict(invoice: {
  aiExtractedData?: unknown; amountHt: string | number; amountTtc: string | number;
}): string | null {
  const source = invoice.aiExtractedData as DepositDocument | null;
  const resolution = (source as any)?._requestResolution;
  if (resolution?.evidenceKey === invoiceRequestEvidenceKey(source)
    && resolution.amountHt === Number(invoice.amountHt)
    && resolution.amountTtc === Number(invoice.amountTtc)
    && typeof resolution.reason === "string" && resolution.reason.trim().length >= 20) return null;
  if (!source || !["invoice", "acompte"].includes(source.documentType ?? "")) return null;
  // Already-paid deductions are a different accounting event.
  if ((source.acomptePaidAmountTtc ?? 0) > 0) return null;
  const heading = [source.openingDepositEvidenceText, source.rawText, source.acompteTrigger]
    .some(text => typeof text === "string" && openingDepositEvidence(text));
  if (!heading && source.documentType !== "acompte") return null;
  const deposit = resolveOpeningDeposit(source);
  if (!deposit) {
    // A document containing only the deposit's own totals is safe only when its
    // explicit requested net agrees with those totals and with the saved pair.
    if (source.netAPayer != null && source.amountTtc != null && source.amountHt != null
      && Math.abs(source.netAPayer - source.amountTtc) < 0.005
      && Math.abs(Number(invoice.amountTtc) - source.amountTtc) < 0.005
      && Math.abs(Number(invoice.amountHt) - source.amountHt) < 0.005) return null;
    return "Opening-deposit evidence is unresolved. The requested amount and tax breakdown must be reviewed before this invoice can be confirmed, approved or certified. A general review acknowledgement does not resolve this conflict.";
  }
  if (Math.abs(Number(invoice.amountHt) - deposit.amountHt) < 0.005
    && Math.abs(Number(invoice.amountTtc) - deposit.amountTtc) < 0.005) return null;
  return `This invoice requests a ${deposit.percentage}% opening deposit: ${deposit.amountTtc.toFixed(2)} EUR TTC (${deposit.amountHt.toFixed(2)} EUR HT at ${deposit.rate}% TVA). The saved amounts do not match that request. Full quotation totals are reference information, not the amount to approve. Apply the requested deposit amounts before proceeding.`;
}
