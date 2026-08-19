// Task #426 — integration coverage for the atomic confirmation of a caught
// architect fee invoice, against the REAL dev database (migration 0069).
//
// Covers: happy-path creation, double-confirm replay idempotency, the
// Pennylane-existing ATTACH path, ref-conflict parking, and refusal when
// the milestone is already invoiced.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import { eq, inArray } from "drizzle-orm";
import {
  architectFeeInvoices,
  architectFeeInvoiceEvents,
  designContractMilestones,
  designContracts,
  feeEntries,
  fees,
  projects,
} from "@shared/schema";
import { normalizeInvoiceRef } from "@shared/architect-fee-match";
import { confirmArchitectFeeInvoice } from "../services/architect-fee-invoice-confirm.service";

const STAMP = Date.now();
const REF1 = `TEST-426-${STAMP}-A`;
const REF2 = `TEST-426-${STAMP}-B`;
const REF3 = `TEST-426-${STAMP}-C`;
const OWNER_USER_ID = 810_000_000 + (STAMP % 100_000_000);

let projectId: number;
let contractId: number;
let milestone1: number;
let milestone2: number;
let milestone3: number;
let milestone4: number;
let milestone5: number;
const evidenceIds: number[] = [];

async function insertEvidence(args: {
  ref: string;
  amountHt: string;
  issueDate: string;
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
      clientName: "Client Test 426",
      fileName: `${args.ref}.pdf`,
      source: "gmail",
      status: "pending_review",
      identityReason: "test fixture",
    })
    .returning();
  evidenceIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({
      name: `TEST 426 PROJECT ${STAMP}`,
      code: `T426-${STAMP}`,
      clientName: "Client Test 426",
    })
    .returning();
  projectId = project.id;

  const [contract] = await db
    .insert(designContracts)
    .values({
      projectId,
      totalTtc: "12000.00",
      originalFilename: "contract.pdf",
      storageKey: `test/contract-${STAMP}.pdf`,
      uploadedByUserId: OWNER_USER_ID,
    })
    .returning();
  contractId = contract.id;

  const ms = await db
    .insert(designContractMilestones)
    .values([
      { contractId, sequence: 1, labelFr: "OUVERTURE ADMINISTRATIVE", percentage: "10.00", amountTtc: "1200.00", status: "reached", reachedAt: new Date() },
      { contractId, sequence: 2, labelFr: "AVANT-PROJET", percentage: "30.00", amountTtc: "3600.00", status: "reached", reachedAt: new Date() },
      { contractId, sequence: 3, labelFr: "PERMIS", percentage: "30.00", amountTtc: "3600.00", status: "reached", reachedAt: new Date() },
      { contractId, sequence: 4, labelFr: "CONSULTATION", percentage: "15.00", amountTtc: "1800.00", status: "reached", reachedAt: new Date() },
      { contractId, sequence: 5, labelFr: "CHANTIER", percentage: "15.00", amountTtc: "1800.00", status: "reached", reachedAt: new Date() },
    ])
    .returning();
  milestone1 = ms[0].id;
  milestone2 = ms[1].id;
  milestone3 = ms[2].id;
  milestone4 = ms[3].id;
  milestone5 = ms[4].id;
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
  await db.delete(projects).where(eq(projects.id, projectId)); // cascades contract + milestones
});

describe("confirmArchitectFeeInvoice (Task #426)", () => {
  it("refuses a non-owner before changing evidence, milestone, or fee entries", async () => {
    const evidenceId = await insertEvidence({
      ref: `TEST-426-${STAMP}-FORBIDDEN`,
      amountHt: "1000.00",
      issueDate: "2026-08-10",
    });
    const projectFeeIds = (await db.select().from(fees).where(eq(fees.projectId, projectId))).map(
      (fee) => fee.id,
    );
    const beforeEntries = projectFeeIds.length
      ? await db.select().from(feeEntries).where(inArray(feeEntries.feeId, projectFeeIds))
      : [];

    const result = await confirmArchitectFeeInvoice({
      evidenceId,
      projectId,
      milestoneId: milestone1,
      userId: OWNER_USER_ID + 1,
      actor: "intruder@example.test",
    });
    expect(result).toMatchObject({ ok: false, status: 403, code: "forbidden" });

    const evidence = await storage.getArchitectFeeInvoice(evidenceId);
    expect(evidence?.status).toBe("pending_review");
    expect(evidence?.projectId).toBeNull();
    const milestone = await storage.getDesignContractMilestone(milestone1);
    expect(milestone?.status).toBe("reached");
    const afterEntries = projectFeeIds.length
      ? await db.select().from(feeEntries).where(inArray(feeEntries.feeId, projectFeeIds))
      : [];
    expect(afterEntries).toHaveLength(beforeEntries.length);
    expect(await storage.listArchitectFeeInvoiceEvents(evidenceId)).toHaveLength(0);
  });

  it("happy path: creates the fee entry with EXTRACTED ref/date, invoices the milestone, audits", async () => {
    const evidenceId = await insertEvidence({ ref: REF1, amountHt: "1000.00", issueDate: "2026-08-10" });

    const result = await confirmArchitectFeeInvoice({ evidenceId, projectId, milestoneId: milestone1, userId: OWNER_USER_ID, actor: "tester@renosud.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation).toBe("created");

    const evidence = await storage.getArchitectFeeInvoice(evidenceId);
    expect(evidence?.status).toBe("confirmed");
    expect(evidence?.projectId).toBe(projectId);
    expect(evidence?.milestoneId).toBe(milestone1);
    expect(evidence?.feeEntryId).toBe(result.feeEntryId);
    expect(evidence?.reviewedBy).toBe("tester@renosud.com");

    const milestone = await storage.getDesignContractMilestone(milestone1);
    expect(milestone?.status).toBe("invoiced");
    expect(milestone?.invoicedAt?.toISOString().slice(0, 10)).toBe("2026-08-10"); // extracted date, not today
    expect(milestone?.notes).toContain(REF1);

    const [entry] = await db.select().from(feeEntries).where(eq(feeEntries.id, result.feeEntryId));
    expect(entry.status).toBe("invoiced");
    expect(entry.dateInvoiced).toBe("2026-08-10");
    expect(entry.pennylaneInvoiceNumber).toBe(REF1);
    expect(Number(entry.feeAmount)).toBeCloseTo(1000, 2);

    // Parent conception fee created from contract totals with recomputed invoiced.
    const [fee] = await db.select().from(fees).where(eq(fees.id, entry.feeId));
    expect(fee.feeType).toBe("conception");
    expect(Number(fee.invoicedAmount)).toBeCloseTo(1000, 2);

    const events = await storage.listArchitectFeeInvoiceEvents(evidenceId);
    expect(events.map((e) => e.action)).toContain("confirmed");
  });

  it("double-confirm is an idempotent replay: no second entry, audited as replayed", async () => {
    const evidence = (await storage.listArchitectFeeInvoices("confirmed")).find((e) => e.invoiceNumber === REF1)!;
    const projectFeeIds = (await db.select().from(fees).where(eq(fees.projectId, projectId))).map(
      (fee) => fee.id,
    );
    const before = await db
      .select()
      .from(feeEntries)
      .where(inArray(feeEntries.feeId, projectFeeIds));

    const result = await confirmArchitectFeeInvoice({
      evidenceId: evidence.id,
      projectId,
      milestoneId: milestone1,
      userId: OWNER_USER_ID,
      actor: "tester@renosud.com",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replayed).toBe(true);
    expect(result.feeEntryId).toBe(evidence.feeEntryId);

    const after = await db
      .select()
      .from(feeEntries)
      .where(inArray(feeEntries.feeId, projectFeeIds));
    expect(after.length).toBe(before.length);
    const events = await storage.listArchitectFeeInvoiceEvents(evidence.id);
    expect(events.map((e) => e.action)).toContain("replayed");
  });

  it("ATTACHES to an entry that already exists via the Pennylane push flow (no double-record)", async () => {
    // Simulate the push flow: an invoiced entry already carrying the
    // Pennylane id + human invoice number.
    const projectFees = await db.select().from(fees).where(eq(fees.projectId, projectId));
    const [pushed] = await db
      .insert(feeEntries)
      .values({
        feeId: projectFees[0].id,
        baseHt: "3000.00",
        feeRate: "100.00",
        feeAmount: "3000.00",
        status: "invoiced",
        dateInvoiced: "2026-08-01",
        pennylaneInvoiceId: `test-pl-${STAMP}`,
        pennylaneInvoiceNumber: REF2,
      })
      .returning();

    const evidenceId = await insertEvidence({ ref: REF2, amountHt: "3000.00", issueDate: "2026-08-01" });
    const result = await confirmArchitectFeeInvoice({ evidenceId, projectId, milestoneId: milestone2, userId: OWNER_USER_ID, actor: "tester@renosud.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation).toBe("attached_by_ref");
    expect(result.feeEntryId).toBe(pushed.id);

    // No new entry was created; the pushed entry is untouched.
    const entriesWithAmount = await db.select().from(feeEntries).where(eq(feeEntries.feeId, projectFees[0].id));
    expect(entriesWithAmount.filter((e) => Number(e.feeAmount) === 3000)).toHaveLength(1);
    const [stillPushed] = await db.select().from(feeEntries).where(eq(feeEntries.id, pushed.id));
    expect(stillPushed.dateInvoiced).toBe("2026-08-01");
    expect(stillPushed.pennylaneInvoiceId).toBe(`test-pl-${STAMP}`);

    const milestone = await storage.getDesignContractMilestone(milestone2);
    expect(milestone?.status).toBe("invoiced");
  });

  it("parks a ref conflict for review instead of guessing (evidence stays pending)", async () => {
    // An entry with the SAME amount but a DIFFERENT Pennylane number.
    const projectFees = await db.select().from(fees).where(eq(fees.projectId, projectId));
    await db.insert(feeEntries).values({
      feeId: projectFees[0].id,
      baseHt: "500.00",
      feeRate: "100.00",
      feeAmount: "500.00",
      status: "invoiced",
      dateInvoiced: "2026-08-05",
      pennylaneInvoiceId: `test-pl2-${STAMP}`,
      pennylaneInvoiceNumber: `OTHER-${STAMP}`,
    });

    const evidenceId = await insertEvidence({ ref: REF3, amountHt: "500.00", issueDate: "2026-08-08" });
    const result = await confirmArchitectFeeInvoice({ evidenceId, projectId, milestoneId: milestone3, userId: OWNER_USER_ID, actor: "tester@renosud.com" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.parked).toBe(true);

    const evidence = await storage.getArchitectFeeInvoice(evidenceId);
    expect(evidence?.status).toBe("pending_review"); // parked, NOT confirmed
    expect(evidence?.notes).toContain("⚠");
    const events = await storage.listArchitectFeeInvoiceEvents(evidenceId);
    expect(events.map((e) => e.action)).toContain("conflict_parked");

    const milestone = await storage.getDesignContractMilestone(milestone3);
    expect(milestone?.status).toBe("reached"); // untouched
  });

  it("refuses to confirm onto an already-invoiced milestone", async () => {
    const evidenceId = evidenceIds[evidenceIds.length - 1]; // still pending (parked)
    const result = await confirmArchitectFeeInvoice({ evidenceId, projectId, milestoneId: milestone1, userId: OWNER_USER_ID, actor: "tester@renosud.com" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe("milestone_already_invoiced");
  });

  it("refuses evidence without an extracted issue date (never fabricates a date)", async () => {
    const [row] = await db
      .insert(architectFeeInvoices)
      .values({
        invoiceNumber: `TEST-426-${STAMP}-NODATE`,
        invoiceNumberNormalized: normalizeInvoiceRef(`TEST-426-${STAMP}-NODATE`),
        issueDate: null,
        amountHt: "700.00",
        source: "gmail",
        status: "pending_review",
        fileName: "nodate.pdf",
      })
      .returning();
    evidenceIds.push(row.id);

    const result = await confirmArchitectFeeInvoice({ evidenceId: row.id, projectId, milestoneId: milestone4, userId: OWNER_USER_ID, actor: "tester@renosud.com" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing_issue_date");
    const evidence = await storage.getArchitectFeeInvoice(row.id);
    expect(evidence?.status).toBe("pending_review");
  });

  it("does NOT consume an unrelated non-Pennylane entry on amount match — creates a new one", async () => {
    // Local/manual pending entry with the same amount but NO Pennylane id.
    const projectFees = await db.select().from(fees).where(eq(fees.projectId, projectId));
    const [localEntry] = await db
      .insert(feeEntries)
      .values({ feeId: projectFees[0].id, baseHt: "800.00", feeRate: "100.00", feeAmount: "800.00", status: "pending" })
      .returning();

    const evidenceId = await insertEvidence({ ref: `TEST-426-${STAMP}-D`, amountHt: "800.00", issueDate: "2026-08-09" });
    const result = await confirmArchitectFeeInvoice({ evidenceId, projectId, milestoneId: milestone5, userId: OWNER_USER_ID, actor: "tester@renosud.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation).toBe("created");
    expect(result.feeEntryId).not.toBe(localEntry.id);

    const [untouched] = await db.select().from(feeEntries).where(eq(feeEntries.id, localEntry.id));
    expect(untouched.status).toBe("pending"); // the manual entry was NOT consumed
  });

  it("keeps the append-only audit intact (events never deleted by decisions)", async () => {
    const all = await Promise.all(evidenceIds.map((id) => storage.listArchitectFeeInvoiceEvents(id)));
    expect(all.flat().length).toBeGreaterThanOrEqual(4);
  });
});
