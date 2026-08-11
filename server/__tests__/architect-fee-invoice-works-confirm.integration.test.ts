// Task #430 — integration coverage for the works-commission binding of a
// caught architect fee invoice, against the REAL dev database (migration
// 0070).
//
// Covers: capture-to-candidates (devis reference promoted to first-class
// columns + works-fee suggestions ranked), happy-path invoicing of the
// EXISTING pending works entry, replay idempotency, refusal on an
// already-invoiced entry, ref-conflict parking, the Pennylane ATTACH path,
// and the non-works-entry refusal.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import { eq, inArray } from "drizzle-orm";
import {
  architectFeeInvoices,
  architectFeeInvoiceEvents,
  contractors,
  devis,
  feeEntries,
  fees,
  invoices,
  projects,
} from "@shared/schema";
import { normalizeInvoiceRef } from "@shared/architect-fee-match";
import { captureArchitectFeeInvoice } from "../services/architect-fee-invoice.service";
import { confirmArchitectFeeInvoiceWorks } from "../services/architect-fee-invoice-confirm.service";
import type { ParsedDocument } from "../gmail/document-parser";

const STAMP = Date.now();
const DEVIS_REF = `DEV-430-${STAMP}`;
const REF1 = `TEST-430-${STAMP}-A`;
const REF2 = `TEST-430-${STAMP}-B`;
const REF3 = `TEST-430-${STAMP}-C`;
const REF4 = `TEST-430-${STAMP}-D`;
const REF5 = `TEST-430-${STAMP}-E`;

let projectId: number;
let contractorId: number;
let devisId: number;
let invoiceId: number;
let worksFeeId: number;
let worksEntryId: number;
const evidenceIds: number[] = [];

async function insertEvidence(args: {
  ref: string;
  amountHt: string;
  issueDate: string | null;
  devisNumber?: string | null;
}): Promise<number> {
  const [row] = await db
    .insert(architectFeeInvoices)
    .values({
      invoiceNumber: args.ref,
      invoiceNumberNormalized: normalizeInvoiceRef(args.ref),
      issueDate: args.issueDate,
      amountHt: args.amountHt,
      tvaAmount: (Number(args.amountHt) * 0.2).toFixed(2),
      amountTtc: (Number(args.amountHt) * 1.2).toFixed(2),
      clientName: "Client Test 430",
      devisNumber: args.devisNumber ?? null,
      devisNumberNormalized: normalizeInvoiceRef(args.devisNumber) || null,
      fileName: `${args.ref}.pdf`,
      source: "gmail",
      status: "pending_review",
      identityReason: "test fixture",
    })
    .returning();
  evidenceIds.push(row.id);
  return row.id;
}

async function insertWorksEntry(args: {
  feeAmount: string;
  baseHt?: string;
  status?: string;
  pennylaneInvoiceId?: string | null;
  pennylaneInvoiceNumber?: string | null;
  withInvoice?: boolean;
}): Promise<number> {
  const [entry] = await db
    .insert(feeEntries)
    .values({
      feeId: worksFeeId,
      invoiceId: args.withInvoice ? invoiceId : null,
      devisId,
      baseHt: args.baseHt ?? "5000.00",
      feeRate: "7.00",
      feeAmount: args.feeAmount,
      status: args.status ?? "pending",
      pennylaneInvoiceId: args.pennylaneInvoiceId ?? null,
      pennylaneInvoiceNumber: args.pennylaneInvoiceNumber ?? null,
    })
    .returning();
  return entry.id;
}

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({
      name: `TEST 430 PROJECT ${STAMP}`,
      code: `T430-${STAMP}`,
      clientName: "Client Test 430",
      feePercentage: "7.00",
    })
    .returning();
  projectId = project.id;

  const [contractor] = await db
    .insert(contractors)
    .values({ name: `MACONNERIE TEST QUATRE TRENTE ${STAMP}` })
    .returning();
  contractorId = contractor.id;

  const [d] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: `T430-DC-${STAMP}`,
      devisNumber: DEVIS_REF,
      descriptionFr: "Gros œuvre test 430",
      amountHt: "5000.00",
      amountTtc: "6000.00",
    })
    .returning();
  devisId = d.id;

  const [inv] = await db
    .insert(invoices)
    .values({
      devisId,
      contractorId,
      projectId,
      invoiceNumber: `FC-430-${STAMP}`,
      amountHt: "5000.00",
      tvaAmount: "1000.00",
      amountTtc: "6000.00",
      status: "approved",
    })
    .returning();
  invoiceId = inv.id;

  const [fee] = await db
    .insert(fees)
    .values({
      projectId,
      feeType: "works_percentage",
      baseAmountHt: "5000.00",
      feeRate: "7.00",
      feeAmountHt: "350.00",
      invoicedAmount: "0.00",
      remainingAmount: "350.00",
      status: "active",
    })
    .returning();
  worksFeeId = fee.id;

  worksEntryId = await insertWorksEntry({ feeAmount: "350.00", withInvoice: true });
});

afterAll(async () => {
  if (evidenceIds.length) {
    await db.delete(architectFeeInvoices).where(inArray(architectFeeInvoices.id, evidenceIds));
  }
  const projectFees = await db.select().from(fees).where(eq(fees.projectId, projectId));
  if (projectFees.length) {
    await db.delete(feeEntries).where(inArray(feeEntries.feeId, projectFees.map((f) => f.id)));
    await db.delete(fees).where(eq(fees.projectId, projectId));
  }
  await db.delete(projects).where(eq(projects.id, projectId)); // cascades devis + invoices
  await db.delete(contractors).where(eq(contractors.id, contractorId));
});

describe("captureArchitectFeeInvoice — works-commission correlation (Task #430)", () => {
  it("promotes the extracted devis reference to columns and ranks the pending works entry", async () => {
    const parsed = {
      documentType: "architect_fee_invoice",
      contractorName: "ARCHITECTS-FRANCE",
      clientName: "Client Test 430",
      invoiceNumber: REF1,
      devisNumber: DEVIS_REF,
      date: "2026-08-10",
      amountHt: 350.0,
      tvaAmount: 70.0,
      amountTtc: 420.0,
      description: `Honoraires 7% sur travaux MACONNERIE TEST QUATRE TRENTE ${STAMP} — devis ${DEVIS_REF}`,
    } as unknown as ParsedDocument;

    const capture = await captureArchitectFeeInvoice({ parsed, fileName: `${REF1}.pdf` });
    expect(capture.outcome).toBe("created");
    evidenceIds.push(capture.id);

    const row = await storage.getArchitectFeeInvoice(capture.id);
    expect(row?.devisNumber).toBe(DEVIS_REF);
    expect(row?.devisNumberNormalized).toBe(normalizeInvoiceRef(DEVIS_REF));

    const candidates = row?.candidates as {
      projects: { projectId: number }[];
      worksFees: Record<string, { feeEntryId: number; score: number; reasons: string[] }[]>;
    };
    expect(candidates.projects.some((p) => p.projectId === projectId)).toBe(true);
    const works = candidates.worksFees[String(projectId)] ?? [];
    expect(works.length).toBeGreaterThan(0);
    expect(works[0].feeEntryId).toBe(worksEntryId);
    // devis-ref + exact-amount + contractor-name = strong score
    expect(works[0].score).toBeGreaterThanOrEqual(100);
  });
});

describe("confirmArchitectFeeInvoiceWorks (Task #430)", () => {
  it("happy path: invoices the EXISTING pending works entry with the EXTRACTED ref/date, no milestone, audited", async () => {
    const evidenceId = await insertEvidence({ ref: REF2, amountHt: "350.00", issueDate: "2026-08-10", devisNumber: DEVIS_REF });

    const result = await confirmArchitectFeeInvoiceWorks({ evidenceId, projectId, feeEntryId: worksEntryId, actor: "tester@renosud.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation).toBe("invoiced_works_entry");
    expect(result.feeEntryId).toBe(worksEntryId);

    const evidence = await storage.getArchitectFeeInvoice(evidenceId);
    expect(evidence?.status).toBe("confirmed");
    expect(evidence?.projectId).toBe(projectId);
    expect(evidence?.milestoneId).toBeNull();
    expect(evidence?.feeEntryId).toBe(worksEntryId);

    const [entry] = await db.select().from(feeEntries).where(eq(feeEntries.id, worksEntryId));
    expect(entry.status).toBe("invoiced");
    expect(entry.dateInvoiced).toBe("2026-08-10");
    expect(entry.pennylaneInvoiceNumber).toBe(REF2);

    // Parent-fee totals recomputed.
    const [fee] = await db.select().from(fees).where(eq(fees.id, worksFeeId));
    expect(Number(fee.invoicedAmount)).toBeCloseTo(350.0, 2);
    expect(Number(fee.remainingAmount)).toBeCloseTo(0, 2);

    const events = await db
      .select()
      .from(architectFeeInvoiceEvents)
      .where(eq(architectFeeInvoiceEvents.architectFeeInvoiceId, evidenceId));
    expect(events.some((e) => e.action === "confirmed")).toBe(true);
    const details = events.find((e) => e.action === "confirmed")?.details as { binding?: string };
    expect(details?.binding).toBe("works_fee_entry");
  });

  it("replay: re-confirming the same binding is a no-op success, audited as replayed", async () => {
    const evidence = (await storage.listArchitectFeeInvoices("confirmed")).find((r) => r.invoiceNumber === REF2)!;
    const result = await confirmArchitectFeeInvoiceWorks({ evidenceId: evidence.id, projectId, feeEntryId: worksEntryId, actor: "tester@renosud.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replayed).toBe(true);
    const events = await db
      .select()
      .from(architectFeeInvoiceEvents)
      .where(eq(architectFeeInvoiceEvents.architectFeeInvoiceId, evidence.id));
    expect(events.some((e) => e.action === "replayed")).toBe(true);
  });

  it("refuses an already-invoiced (non-Pennylane) entry", async () => {
    const invoicedEntry = await insertWorksEntry({ feeAmount: "70.00", status: "invoiced" });
    const evidenceId = await insertEvidence({ ref: REF3, amountHt: "70.00", issueDate: "2026-08-10" });
    const result = await confirmArchitectFeeInvoiceWorks({ evidenceId, projectId, feeEntryId: invoicedEntry, actor: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("entry_already_invoiced");
    const evidence = await storage.getArchitectFeeInvoice(evidenceId);
    expect(evidence?.status).toBe("pending_review");
  });

  it("parks on ref conflict: the invoice ref already lives on a DIFFERENT entry", async () => {
    await insertWorksEntry({ feeAmount: "35.00", status: "invoiced", pennylaneInvoiceNumber: REF4 });
    const targetEntry = await insertWorksEntry({ feeAmount: "35.00" });
    const evidenceId = await insertEvidence({ ref: REF4, amountHt: "35.00", issueDate: "2026-08-10" });
    const result = await confirmArchitectFeeInvoiceWorks({ evidenceId, projectId, feeEntryId: targetEntry, actor: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ref_conflict");
    expect(result.parked).toBe(true);
    const evidence = await storage.getArchitectFeeInvoice(evidenceId);
    expect(evidence?.status).toBe("pending_review");
    expect(evidence?.notes).toContain("⚠");
  });

  it("parks on cross-project ref conflict: the ref lives on an entry of ANOTHER project", async () => {
    const OTHER_REF = `TEST-430-${STAMP}-XP`;
    // Second project carrying a fee entry that already bears the ref.
    const [otherProject] = await db
      .insert(projects)
      .values({ name: `TEST 430 OTHER ${STAMP}`, code: `T430B-${STAMP}`, clientName: "Autre Client 430" })
      .returning();
    const [otherFee] = await db
      .insert(fees)
      .values({
        projectId: otherProject.id,
        feeType: "works_percentage",
        baseAmountHt: "1000.00",
        feeRate: "7.00",
        feeAmountHt: "70.00",
        invoicedAmount: "0.00",
        remainingAmount: "70.00",
        status: "active",
      })
      .returning();
    await db
      .insert(feeEntries)
      .values({ feeId: otherFee.id, baseHt: "1000.00", feeRate: "7.00", feeAmount: "70.00", status: "invoiced", pennylaneInvoiceNumber: OTHER_REF })
      .returning();
    try {
      const targetEntry = await insertWorksEntry({ feeAmount: "70.00" });
      const evidenceId = await insertEvidence({ ref: OTHER_REF, amountHt: "70.00", issueDate: "2026-08-11" });
      const result = await confirmArchitectFeeInvoiceWorks({ evidenceId, projectId, feeEntryId: targetEntry, actor: null });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ref_conflict");
      expect(result.parked).toBe(true);
      // The target entry in OUR project was not touched.
      const [entry] = await db.select().from(feeEntries).where(eq(feeEntries.id, targetEntry));
      expect(entry.status).toBe("pending");
    } finally {
      await db.delete(feeEntries).where(eq(feeEntries.feeId, otherFee.id));
      await db.delete(fees).where(eq(fees.projectId, otherProject.id));
      await db.delete(projects).where(eq(projects.id, otherProject.id));
    }
  });

  it("ATTACHES to a Pennylane-pushed entry (invoiced, id set): number backfilled, no state change", async () => {
    const pushedEntry = await insertWorksEntry({ feeAmount: "140.00", status: "invoiced", pennylaneInvoiceId: `pl-${STAMP}` });
    const evidenceId = await insertEvidence({ ref: REF5, amountHt: "140.00", issueDate: "2026-08-11" });
    const result = await confirmArchitectFeeInvoiceWorks({ evidenceId, projectId, feeEntryId: pushedEntry, actor: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation).toBe("attached_by_ref");
    const [entry] = await db.select().from(feeEntries).where(eq(feeEntries.id, pushedEntry));
    expect(entry.status).toBe("invoiced");
    expect(entry.pennylaneInvoiceNumber).toBe(REF5);
  });

  it("refuses a non-works fee entry (conception) — milestone flow owns those", async () => {
    const [conceptionFee] = await db
      .insert(fees)
      .values({
        projectId,
        feeType: "conception",
        baseAmountHt: "1000.00",
        feeAmountHt: "1000.00",
        invoicedAmount: "0.00",
        remainingAmount: "1000.00",
        status: "pending",
      })
      .returning();
    const [conceptionEntry] = await db
      .insert(feeEntries)
      .values({ feeId: conceptionFee.id, baseHt: "1000.00", feeRate: "100.00", feeAmount: "1000.00", status: "pending" })
      .returning();
    const evidenceId = await insertEvidence({ ref: `${REF5}-X`, amountHt: "1000.00", issueDate: "2026-08-11" });
    const result = await confirmArchitectFeeInvoiceWorks({ evidenceId, projectId, feeEntryId: conceptionEntry.id, actor: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_works_entry");
  });

  it("refuses when the extracted issue date is missing", async () => {
    const entry = await insertWorksEntry({ feeAmount: "10.00" });
    const evidenceId = await insertEvidence({ ref: `${REF5}-Y`, amountHt: "10.00", issueDate: null });
    const result = await confirmArchitectFeeInvoiceWorks({ evidenceId, projectId, feeEntryId: entry, actor: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing_issue_date");
  });
});
