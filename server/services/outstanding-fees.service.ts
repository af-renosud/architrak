import { db } from "../db";
import { eq, and, isNull, sql } from "drizzle-orm";
import {
  feeEntries,
  fees,
  projects,
  invoices,
  contractors,
  devis,
} from "@shared/schema";
import {
  summarizeOutstandingFees,
  type OutstandingFeeEntry,
  type OutstandingFeeSummary,
} from "@shared/fee-description";
import { calculateFeeAmount, roundCurrency } from "@shared/financial-utils";
import { buildFeeInvoiceDescription } from "@shared/fee-description";

interface QueryFilter {
  projectId?: number;
}

async function fetchOutstandingRows(filter: QueryFilter): Promise<OutstandingFeeEntry[]> {
  const conditions = [
    eq(feeEntries.status, "pending"),
    isNull(feeEntries.pennylaneInvoiceRef),
    // Architect Project-Management fee monitor is scoped to the
    // works-percentage flow; conception and planning fees follow a
    // different invoicing process and are excluded.
    eq(fees.feeType, "works_percentage"),
  ];
  if (filter.projectId !== undefined) {
    conditions.push(eq(fees.projectId, filter.projectId));
  }

  const rows = await db
    .select({
      entryId: feeEntries.id,
      feeId: feeEntries.feeId,
      entryFeeAmount: feeEntries.feeAmount,
      entryFeeRate: feeEntries.feeRate,
      entryBaseHt: feeEntries.baseHt,
      entryCreatedAt: feeEntries.createdAt,
      invoiceId: feeEntries.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      invoiceAmountHt: invoices.amountHt,
      invoiceAmountTtc: invoices.amountTtc,
      invoiceCreatedAt: invoices.createdAt,
      invoiceContractorId: invoices.contractorId,
      contractorName: contractors.name,
      devisId: feeEntries.devisId,
      devisCode: devis.devisCode,
      projectId: fees.projectId,
      projectName: projects.name,
      projectCode: projects.code,
      projectFeePercentage: projects.feePercentage,
    })
    .from(feeEntries)
    .innerJoin(fees, eq(fees.id, feeEntries.feeId))
    .innerJoin(projects, eq(projects.id, fees.projectId))
    .leftJoin(invoices, eq(invoices.id, feeEntries.invoiceId))
    .leftJoin(contractors, eq(contractors.id, invoices.contractorId))
    .leftJoin(devis, eq(devis.id, feeEntries.devisId))
    .where(and(...conditions))
    .orderBy(sql`${feeEntries.createdAt} ASC`);

  const now = Date.now();
  return rows.map((r) => {
    // Age is measured from the contractor invoice's record creation
    // (proxy for "approved on" — invoice rows are inserted on approval flow),
    // falling back to the fee_entry's createdAt when the invoice link is null.
    const ageSource = r.invoiceCreatedAt ?? r.entryCreatedAt;
    const createdAt = ageSource instanceof Date
      ? ageSource
      : new Date(String(ageSource));
    const ageMs = Math.max(0, now - createdAt.getTime());
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    const amountHt = r.invoiceAmountHt != null
      ? parseFloat(r.invoiceAmountHt)
      : parseFloat(r.entryBaseHt);
    const amountTtc = r.invoiceAmountTtc != null
      ? parseFloat(r.invoiceAmountTtc)
      : 0;
    const feePercentage = r.projectFeePercentage != null
      ? parseFloat(r.projectFeePercentage)
      : parseFloat(r.entryFeeRate);
    // Always recompute deterministically from invoice HT × project fee %
    // rather than trusting the persisted entry value — this is what the
    // accounting copy text and aging buckets must reflect.
    const feeAmountHt = calculateFeeAmount(amountHt, feePercentage);
    void r.entryFeeAmount;

    return {
      entryId: r.entryId,
      feeId: r.feeId,
      projectId: r.projectId,
      projectName: r.projectName,
      projectCode: r.projectCode,
      contractorName: r.contractorName ?? null,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber ?? null,
      devisId: r.devisId,
      devisCode: r.devisCode ?? null,
      amountHt: roundCurrency(amountHt),
      amountTtc: roundCurrency(amountTtc),
      feePercentage,
      feeAmountHt,
      createdAt: createdAt.toISOString(),
      ageDays,
    };
  });
}

export async function getOutstandingFeesGlobal(): Promise<OutstandingFeeSummary> {
  const entries = await fetchOutstandingRows({});
  return summarizeOutstandingFees(entries);
}

export async function getOutstandingFeesForProject(
  projectId: number,
): Promise<OutstandingFeeSummary> {
  const entries = await fetchOutstandingRows({ projectId });
  return summarizeOutstandingFees(entries);
}

export async function getFeeEntryCopyText(entryId: number): Promise<string | null> {
  const [entry] = await fetchOutstandingRowsForEntry(entryId);
  if (!entry) return null;
  return buildFeeInvoiceDescription({
    contractorName: entry.contractorName,
    invoiceNumber: entry.invoiceNumber,
    devisCode: entry.devisCode,
    amountHt: entry.amountHt,
    amountTtc: entry.amountTtc,
    feePercentage: entry.feePercentage,
  });
}

async function fetchOutstandingRowsForEntry(entryId: number): Promise<OutstandingFeeEntry[]> {
  // Reuse the same join + canonical recomputation as the listing query so
  // the copy text and the panel always agree. Enforces the same outstanding
  // predicate (works-percentage + pending + no Pennylane ref) so the copy
  // endpoint cannot leak text for entries outside this monitor's scope.
  const conditions = [
    eq(feeEntries.id, entryId),
    eq(feeEntries.status, "pending"),
    isNull(feeEntries.pennylaneInvoiceRef),
    eq(fees.feeType, "works_percentage"),
  ];
  const rows = await db
    .select({
      entryId: feeEntries.id,
      feeId: feeEntries.feeId,
      entryFeeAmount: feeEntries.feeAmount,
      entryFeeRate: feeEntries.feeRate,
      entryBaseHt: feeEntries.baseHt,
      entryCreatedAt: feeEntries.createdAt,
      invoiceId: feeEntries.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      invoiceAmountHt: invoices.amountHt,
      invoiceAmountTtc: invoices.amountTtc,
      invoiceCreatedAt: invoices.createdAt,
      invoiceContractorId: invoices.contractorId,
      contractorName: contractors.name,
      devisId: feeEntries.devisId,
      devisCode: devis.devisCode,
      projectId: fees.projectId,
      projectName: projects.name,
      projectCode: projects.code,
      projectFeePercentage: projects.feePercentage,
    })
    .from(feeEntries)
    .innerJoin(fees, eq(fees.id, feeEntries.feeId))
    .innerJoin(projects, eq(projects.id, fees.projectId))
    .leftJoin(invoices, eq(invoices.id, feeEntries.invoiceId))
    .leftJoin(contractors, eq(contractors.id, invoices.contractorId))
    .leftJoin(devis, eq(devis.id, feeEntries.devisId))
    .where(and(...conditions));

  const now = Date.now();
  return rows.map((r) => {
    const ageSource = r.invoiceCreatedAt ?? r.entryCreatedAt;
    const createdAt = ageSource instanceof Date ? ageSource : new Date(String(ageSource));
    const ageDays = Math.floor(Math.max(0, now - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    const amountHt = r.invoiceAmountHt != null ? parseFloat(r.invoiceAmountHt) : parseFloat(r.entryBaseHt);
    const amountTtc = r.invoiceAmountTtc != null ? parseFloat(r.invoiceAmountTtc) : 0;
    const feePercentage = r.projectFeePercentage != null
      ? parseFloat(r.projectFeePercentage)
      : parseFloat(r.entryFeeRate);
    return {
      entryId: r.entryId,
      feeId: r.feeId,
      projectId: r.projectId,
      projectName: r.projectName,
      projectCode: r.projectCode,
      contractorName: r.contractorName ?? null,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber ?? null,
      devisId: r.devisId,
      devisCode: r.devisCode ?? null,
      amountHt: roundCurrency(amountHt),
      amountTtc: roundCurrency(amountTtc),
      feePercentage,
      feeAmountHt: calculateFeeAmount(amountHt, feePercentage),
      createdAt: createdAt.toISOString(),
      ageDays,
    };
  });
}
