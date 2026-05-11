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

interface QueryFilter {
  projectId?: number;
}

async function fetchOutstandingRows(filter: QueryFilter): Promise<OutstandingFeeEntry[]> {
  const conditions = [
    eq(feeEntries.status, "pending"),
    isNull(feeEntries.pennylaneInvoiceRef),
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
    const createdAt = r.entryCreatedAt instanceof Date
      ? r.entryCreatedAt
      : new Date(String(r.entryCreatedAt));
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
    const feeAmountHt = roundCurrency(
      r.entryFeeAmount != null
        ? parseFloat(r.entryFeeAmount)
        : calculateFeeAmount(amountHt, feePercentage),
    );

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
