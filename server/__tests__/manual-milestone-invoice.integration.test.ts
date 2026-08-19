import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  architectFeeInvoiceEvents,
  architectFeeInvoices,
  designContractMilestones,
  designContracts,
  feeEntries,
  fees,
  milestonePaymentSuggestions,
  projects,
} from "@shared/schema";
import {
  completePaidMilestoneDetails,
  recordManualMilestoneInvoice,
} from "../services/manual-milestone-invoice.service";
import { markMilestonePaidManually } from "../services/milestone-payment-suggestions.service";

const stamp = Date.now();
const ownerUserId = 800_000_000 + (stamp % 100_000_000);
let projectId: number;
let contractId: number;
let reachedMilestoneId: number;
let duplicateMilestoneId: number;
let legacyPaidMilestoneId: number;
let raceMilestoneId: number;
let legacyEntryId: number;
let legacyEvidenceId: number;

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({
      name: `Manual milestone invoice ${stamp}`,
      code: `MMI-${stamp}`,
      clientName: "Manual Invoice Client",
    })
    .returning();
  projectId = project.id;

  const [contract] = await db
    .insert(designContracts)
    .values({
      projectId,
      storageKey: `tests/manual-milestone-${stamp}.pdf`,
      originalFilename: "manual-milestone.pdf",
      totalHt: "10000.00",
      totalTva: "2000.00",
      totalTtc: "12000.00",
      tvaRate: "20.00",
      uploadedByUserId: ownerUserId,
    })
    .returning();
  contractId = contract.id;

  const milestones = await db
    .insert(designContractMilestones)
    .values([
      {
        contractId,
        sequence: 1,
        labelFr: "Reached invoice",
        percentage: "20.00",
        amountTtc: "2400.00",
        triggerEvent: "manual",
        status: "reached",
        reachedAt: new Date(),
      },
      {
        contractId,
        sequence: 2,
        labelFr: "Duplicate guard",
        percentage: "20.00",
        amountTtc: "2400.00",
        triggerEvent: "manual",
        status: "reached",
        reachedAt: new Date(),
      },
      {
        contractId,
        sequence: 3,
        labelFr: "Legacy paid",
        percentage: "20.00",
        amountTtc: "2400.00",
        triggerEvent: "manual",
        status: "paid",
        reachedAt: new Date(),
        paidAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        contractId,
        sequence: 4,
        labelFr: "Concurrent payment",
        percentage: "20.00",
        amountTtc: "2400.00",
        triggerEvent: "manual",
        status: "reached",
        reachedAt: new Date(),
      },
    ])
    .returning();
  reachedMilestoneId = milestones[0].id;
  duplicateMilestoneId = milestones[1].id;
  legacyPaidMilestoneId = milestones[2].id;
  raceMilestoneId = milestones[3].id;

  const [fee] = await db
    .insert(fees)
    .values({
      projectId,
      feeType: "conception",
      baseAmountHt: "10000.00",
      feeAmountHt: "10000.00",
      invoicedAmount: "0.00",
      remainingAmount: "10000.00",
      status: "pending",
    })
    .returning();
  const [legacyEntry] = await db
    .insert(feeEntries)
    .values({
      feeId: fee.id,
      baseHt: "2000.00",
      feeRate: "100.00",
      feeAmount: "2000.00",
      status: "pending",
    })
    .returning();
  legacyEntryId = legacyEntry.id;
  const [legacyEvidence] = await db
    .insert(architectFeeInvoices)
    .values({
      projectId,
      milestoneId: legacyPaidMilestoneId,
      feeEntryId: legacyEntryId,
      amountHt: "2000.00",
      amountTtc: "2400.00",
      source: "manual",
      status: "confirmed",
    })
    .returning();
  legacyEvidenceId = legacyEvidence.id;
});

afterAll(async () => {
  if (!projectId) return;
  await db.delete(architectFeeInvoices).where(eq(architectFeeInvoices.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("manual design-milestone invoice and payment workflow", () => {
  it("records Reached → Invoiced atomically through evidence and fee-entry records", async () => {
    const result = await recordManualMilestoneInvoice({
      milestoneId: reachedMilestoneId,
      userId: ownerUserId,
      actor: "owner@example.test",
      invoiceNumber: `FA-${stamp}`,
      invoiceDate: "2026-08-18",
      notes: "Invoice note",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation).toBe("created");

    const [milestone] = await db
      .select()
      .from(designContractMilestones)
      .where(eq(designContractMilestones.id, reachedMilestoneId));
    expect(milestone.status).toBe("invoiced");
    expect(milestone.invoicedAt?.toISOString().slice(0, 10)).toBe("2026-08-18");
    expect(milestone.notes).toContain("Invoice note");

    const [evidence] = await db
      .select()
      .from(architectFeeInvoices)
      .where(eq(architectFeeInvoices.milestoneId, reachedMilestoneId));
    expect(evidence.invoiceNumber).toBe(`FA-${stamp}`);
    expect(evidence.issueDate).toBe("2026-08-18");
    expect(evidence.status).toBe("confirmed");
    expect(evidence.feeEntryId).toBe(result.feeEntryId);

    const [entry] = await db
      .select()
      .from(feeEntries)
      .where(eq(feeEntries.id, result.feeEntryId));
    expect(entry.status).toBe("invoiced");
    expect(entry.dateInvoiced).toBe("2026-08-18");
    expect(entry.pennylaneInvoiceNumber).toBe(`FA-${stamp}`);
    expect(Number(entry.feeAmount)).toBeCloseTo(2000, 2);

    const events = await db
      .select()
      .from(architectFeeInvoiceEvents)
      .where(eq(architectFeeInvoiceEvents.architectFeeInvoiceId, evidence.id));
    expect(events.some((event) => event.action === "confirmed")).toBe(true);
  });

  it("rejects duplicate normalized invoice numbers without advancing the other milestone", async () => {
    const result = await recordManualMilestoneInvoice({
      milestoneId: duplicateMilestoneId,
      userId: ownerUserId,
      actor: "owner@example.test",
      invoiceNumber: ` fa ${stamp} `,
      invoiceDate: "2026-08-19",
    });
    expect(result).toMatchObject({ ok: false, status: 409, code: "DUPLICATE_INVOICE_NUMBER" });
    const [milestone] = await db
      .select()
      .from(designContractMilestones)
      .where(eq(designContractMilestones.id, duplicateMilestoneId));
    expect(milestone.status).toBe("reached");
  });

  it("completes a legacy Paid milestone by reusing its linked entry and retaining Paid status", async () => {
    const beforeEntries = await db
      .select()
      .from(feeEntries)
      .innerJoin(fees, eq(feeEntries.feeId, fees.id))
      .where(eq(fees.projectId, projectId));
    const result = await completePaidMilestoneDetails({
      milestoneId: legacyPaidMilestoneId,
      userId: ownerUserId,
      actor: "owner@example.test",
      invoiceNumber: `LEG-${stamp}`,
      invoiceDate: "2025-12-10",
      paymentDate: "2025-12-22",
      notes: "Historical note",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation).toBe("existing_evidence");
    expect(result.feeEntryId).toBe(legacyEntryId);
    expect(result.evidence.id).toBe(legacyEvidenceId);

    const [milestone] = await db
      .select()
      .from(designContractMilestones)
      .where(eq(designContractMilestones.id, legacyPaidMilestoneId));
    expect(milestone.status).toBe("paid");
    expect(milestone.invoicedAt?.toISOString().slice(0, 10)).toBe("2025-12-10");
    expect(milestone.paidAt?.toISOString().slice(0, 10)).toBe("2025-12-22");
    expect(milestone.notes).toContain("Historical note");

    const afterEntries = await db
      .select()
      .from(feeEntries)
      .innerJoin(fees, eq(feeEntries.feeId, fees.id))
      .where(eq(fees.projectId, projectId));
    expect(afterEntries).toHaveLength(beforeEntries.length);
  });

  it("requires Invoiced for manual payment and serializes concurrent confirmations", async () => {
    const reachedRefusal = await markMilestonePaidManually({
      milestoneId: duplicateMilestoneId,
      userId: ownerUserId,
      actor: "owner@example.test",
      paymentDate: "2026-08-19",
    });
    expect(reachedRefusal).toMatchObject({ ok: false, status: 409, code: "milestone_not_payable" });

    const invoice = await recordManualMilestoneInvoice({
      milestoneId: raceMilestoneId,
      userId: ownerUserId,
      actor: "owner@example.test",
      invoiceNumber: `RACE-${stamp}`,
      invoiceDate: "2026-08-12",
    });
    expect(invoice.ok).toBe(true);

    await db.insert(milestonePaymentSuggestions).values({
      milestoneId: raceMilestoneId,
      projectId,
      emailMessageId: `race-${stamp}@example.test`,
      emailThreadId: `race-thread-${stamp}`,
      senderEmail: "client@example.test",
      emailDate: new Date(),
      suggestedAmount: "2400.00",
      suggestedDate: "2026-08-15",
      status: "pending_review",
    });

    const results = await Promise.all([
      markMilestonePaidManually({
        milestoneId: raceMilestoneId,
        userId: ownerUserId,
        actor: "owner@example.test",
        paymentDate: "2026-08-16",
        notes: "First confirmation",
      }),
      markMilestonePaidManually({
        milestoneId: raceMilestoneId,
        userId: ownerUserId,
        actor: "owner@example.test",
        paymentDate: "2026-08-17",
        notes: "Second confirmation",
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.status === 409)).toHaveLength(1);

    const [milestone] = await db
      .select()
      .from(designContractMilestones)
      .where(eq(designContractMilestones.id, raceMilestoneId));
    expect(milestone.status).toBe("paid");
    expect(["2026-08-16", "2026-08-17"]).toContain(
      milestone.paidAt?.toISOString().slice(0, 10),
    );

    const [suggestion] = await db
      .select()
      .from(milestonePaymentSuggestions)
      .where(
        and(
          eq(milestonePaymentSuggestions.milestoneId, raceMilestoneId),
          eq(milestonePaymentSuggestions.emailMessageId, `race-${stamp}@example.test`),
        ),
      );
    expect(suggestion.status).toBe("dismissed");
  });
});