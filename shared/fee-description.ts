import { calculateFeeAmount, roundCurrency } from "./financial-utils";

export interface OutstandingFeeEntry {
  entryId: number;
  feeId: number;
  projectId: number;
  projectName: string;
  projectCode: string;
  contractorName: string | null;
  invoiceId: number | null;
  invoiceNumber: string | null;
  devisId: number | null;
  devisCode: string | null;
  amountHt: number;
  amountTtc: number;
  feePercentage: number;
  feeAmountHt: number;
  createdAt: string;
  ageDays: number;
}

export interface OutstandingFeeBucket {
  label: "0-30" | "31-60" | "61-90" | "90+";
  count: number;
  totalFeeHt: number;
}

export interface OutstandingFeeSummary {
  totalCount: number;
  totalFeeHt: number;
  buckets: OutstandingFeeBucket[];
  entries: OutstandingFeeEntry[];
}

function formatFrenchAmount(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(roundCurrency(value));
}

function formatRate(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return value
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

export interface FeeDescriptionInput {
  contractorName: string | null;
  invoiceNumber: string | null;
  devisCode: string | null;
  amountHt: number;
  amountTtc: number;
  feePercentage: number;
}

export function buildFeeInvoiceDescription(input: FeeDescriptionInput): string {
  const contractor = (input.contractorName ?? "").trim() || "(unknown contractor)";
  const invoiceNumber = (input.invoiceNumber ?? "").trim() || "(no invoice number)";
  const devisCode = (input.devisCode ?? "").trim() || "(no devis reference)";
  const ht = formatFrenchAmount(input.amountHt);
  const ttc = formatFrenchAmount(input.amountTtc);
  const rate = formatRate(input.feePercentage);
  const feeHt = formatFrenchAmount(calculateFeeAmount(input.amountHt, input.feePercentage));

  return (
    `Architects' Project Management Fees against contractor: ${contractor} ` +
    `and references as follows: ` +
    `Invoice: ${invoiceNumber}. ` +
    `Corresponding signed Devis: ${devisCode}. ` +
    `Contractor's total invoice value TTC: ${ttc} EUR. ` +
    `Contractor's total invoice value HT: ${ht} EUR. ` +
    `Project management fees are calculated as ${rate}% x contractor's invoice ` +
    `${ht} EUR = ${feeHt} EUR HT.`
  );
}

export function bucketAgeDays(ageDays: number): OutstandingFeeBucket["label"] {
  if (ageDays <= 30) return "0-30";
  if (ageDays <= 60) return "31-60";
  if (ageDays <= 90) return "61-90";
  return "90+";
}

export function summarizeOutstandingFees(entries: OutstandingFeeEntry[]): OutstandingFeeSummary {
  const bucketAcc: Record<OutstandingFeeBucket["label"], { count: number; totalFeeHt: number }> = {
    "0-30": { count: 0, totalFeeHt: 0 },
    "31-60": { count: 0, totalFeeHt: 0 },
    "61-90": { count: 0, totalFeeHt: 0 },
    "90+": { count: 0, totalFeeHt: 0 },
  };
  let totalFeeHt = 0;
  for (const e of entries) {
    const label = bucketAgeDays(e.ageDays);
    bucketAcc[label].count += 1;
    bucketAcc[label].totalFeeHt = roundCurrency(bucketAcc[label].totalFeeHt + e.feeAmountHt);
    totalFeeHt = roundCurrency(totalFeeHt + e.feeAmountHt);
  }
  const labels: OutstandingFeeBucket["label"][] = ["0-30", "31-60", "61-90", "90+"];
  return {
    totalCount: entries.length,
    totalFeeHt,
    buckets: labels.map((label) => ({
      label,
      count: bucketAcc[label].count,
      totalFeeHt: bucketAcc[label].totalFeeHt,
    })),
    entries,
  };
}
