import type { ArchitectFeeInvoice, Fee } from "@shared/schema";
import type { FeeVisibilityRecord } from "@shared/fee-visibility";

export type VisibilityFilter = "active" | "archived" | "all";
export interface RegisterContractTotals {
  coveredFeeIds: number[];
  totalTtc: number;
  totalHt: number | null;
  invoicedTtc: number;
  invoicedHt: number | null;
}
export function registerTotals(fees: Pick<Fee, "id" | "feeAmountHt" | "invoicedAmount">[], contract?: RegisterContractTotals | null) {
  const covered = new Set(contract?.coveredFeeIds ?? []);
  const uncovered = fees.filter(fee => !covered.has(fee.id));
  const earned = uncovered.reduce((sum, fee) => sum + Number(fee.feeAmountHt), 0);
  const invoiced = uncovered.reduce((sum, fee) => sum + Number(fee.invoicedAmount ?? 0), 0);
  const totalFeeEarnedTtc = earned * 1.2 + (contract?.totalTtc ?? 0);
  const totalInvoicedTtc = invoiced * 1.2 + (contract?.invoicedTtc ?? 0);
  const totalFeeEarned = contract && contract.totalHt == null ? null : earned + (contract?.totalHt ?? 0);
  const totalInvoiced = contract && contract.invoicedHt == null ? null : invoiced + (contract?.invoicedHt ?? 0);
  return {
    totalFeeEarnedTtc, totalInvoicedTtc,
    totalRemainingTtc: totalFeeEarnedTtc - totalInvoicedTtc,
    totalFeeEarned, totalInvoiced,
    totalRemaining: totalFeeEarned == null || totalInvoiced == null ? null : totalFeeEarned - totalInvoiced,
  };
}
export function matchesVisibility(record: FeeVisibilityRecord | undefined, filter: VisibilityFilter) {
  // Missing visibility is unknown, not an inferred active/archive state.
  return !!record && (filter === "all" || record.archived === (filter === "archived"));
}
export function feeGroupMatchesVisibility(parent: FeeVisibilityRecord | undefined, children: Array<FeeVisibilityRecord | undefined>, filter: VisibilityFilter) {
  if (!parent) return false;
  if (filter === "all") return true;
  // Children never override an archived parent's exclusion from Active.
  if (filter === "active") return !parent.archived;
  return parent.archived || children.some(child => child?.archived === true);
}
export function feeEntryMatchesVisibility(parent: FeeVisibilityRecord | undefined, entry: FeeVisibilityRecord | undefined, filter: VisibilityFilter) {
  if (!parent) return false;
  if (parent.archived) return filter === "archived" || filter === "all";
  if (filter === "all") return true;
  return matchesVisibility(entry, filter);
}
export function detectedForProject(rows: ArchitectFeeInvoice[], projectId: string) {
  if (!projectId) return rows;
  return rows.filter(row => {
    if (row.projectId != null && String(row.projectId) === projectId) return true;
    const candidates = row.candidates as { projects?: { projectId: number }[] } | null;
    return candidates?.projects?.some(project => String(project.projectId) === projectId);
  });
}
export function unassignedDetected(rows: ArchitectFeeInvoice[]) {
  return rows.filter(row => {
    if (row.projectId != null) return false;
    const candidates = row.candidates as { projects?: unknown[] } | null;
    return !candidates?.projects?.length;
  });
}
