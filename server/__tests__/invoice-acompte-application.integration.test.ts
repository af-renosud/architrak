import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../db";
import {
  acompteNoInvoicePayments,
  certificatPayments,
  certificats,
  contractors,
  devis,
  documentAdvisories,
  invoiceAcompteApplications,
  invoices,
  projectIntakeDocuments,
  projects,
  users,
} from "@shared/schema";
import {
  applyInvoiceAcompteDeduction,
  reconcilePaidAcompteFromCertificatLedger,
} from "../services/invoice-acompte-application.service";
import { getProjectFinancialSummary } from "../services/financial-summary.service";
import invoicesRouter from "../routes/invoices";

const refireBackfillStatements = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/0124_refire_invoice_acompte_application_backfill.sql"),
  "utf8",
).split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);

async function runRefireBackfill(): Promise<void> {
  for (const statement of refireBackfillStatements) {
    await db.execute(sql.raw(statement));
  }
}

let projectId: number;
let contractorId: number;
let devisId: number;
let certificatId: number;
let sourceId: number;
let invoiceId: number;
let server: http.Server;
let base: string;

beforeAll(async () => {
  await db.insert(users).values({
    id: 1,
    googleId: "invoice-acompte-application-operator",
    email: "invoice-acompte-application@local.test",
  }).onConflictDoNothing();
  const [project] = await db.insert(projects).values({
    code: `IAA-${Date.now()}`,
    name: "Invoice opening-deposit application",
    clientName: "Test Client",
    status: "active",
  }).returning();
  projectId = project.id;
  const [contractor] = await db.insert(contractors).values({
    name: `Invoice acompte contractor ${Date.now()}`,
  }).returning();
  contractorId = contractor.id;
  const [devisRow] = await db.insert(devis).values({
    projectId,
    contractorId,
    devisCode: "RTBIM.1.TOPOGRAPHIQUE",
    descriptionFr: "Production arithmetic reproduction",
    amountHt: "2075.00",
    amountTtc: "2490.00",
    acompteRequired: true,
    acompteAmountHt: "1240.00",
    acompteState: "pending",
    signOffStage: "client_signed_off",
    accountingState: "active",
  }).returning();
  devisId = devisRow.id;
  const [certificat] = await db.insert(certificats).values({
    projectId,
    contractorId,
    certificateRef: `C-IAA-${Date.now()}`,
    dateIssued: "2026-08-16",
    totalWorksHt: "1240.00",
    pvMvAdjustment: "0.00",
    previousPayments: "0.00",
    retenueGarantie: "0.00",
    cumulativeProrataDeduction: "0.00",
    periodProrataDeduction: "0.00",
    cumulativeAcompteRecoupment: "0.00",
    periodAcompteRecoupment: "0.00",
    tvaRatePercent: "20.00",
    tvaAutoliquidation: false,
    tvaRateSource: "documentary",
    netToPayHt: "1240.00",
    tvaAmount: "248.00",
    netToPayTtc: "1488.00",
    acompteDevisId: devisId,
    status: "paid",
  }).returning();
  certificatId = certificat.id;
  await db.insert(certificatPayments).values({
    certificatId,
    datePaid: "2026-08-17",
    amount: "1488.00",
    reference: "LEDGER-IAA",
    loggedBy: "test",
  });
  const [source] = await db.insert(projectIntakeDocuments).values({
    projectId,
    fileName: "FR25.26-0144.pdf",
    storageKey: "tests/invoice-acompte/FR25.26-0144.pdf",
    contentFingerprint: "c".repeat(64),
    extractedData: {
      documentType: "invoice",
      amountHt: 2075,
      amountTtc: 2490,
      netAPayer: 1002,
      acomptePaidAmountTtc: 1488,
      acomptePaidEvidenceText: "Acompte versé 1 488,00 €",
    },
  }).returning();
  sourceId = source.id;
  const [invoice] = await db.insert(invoices).values({
    projectId,
    contractorId,
    devisId,
    sourceIntakeDocumentId: sourceId,
    invoiceNumber: "FR25.26-0144",
    amountHt: "2075.00",
    tvaAmount: "415.00",
    amountTtc: "2490.00",
    pdfPath: "tests/copied-invoice/FR25.26-0144.pdf",
    // Deliberately stale document total: empty confirm must replace this with
    // the authoritative stored TTC before checking net à payer.
    aiExtractedData: {
      documentType: "invoice",
      amountHt: 2075,
      amountTtc: 3000,
      netAPayer: 1002,
      acomptePaidAmountTtc: 1488,
      acomptePaidEvidenceText: "Acompte versé 1 488,00 €",
    },
  }).returning();
  invoiceId = invoice.id;

  const app = express();
  app.use(express.json());
  app.use(invoicesRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ message: err instanceof Error ? err.message : "Validation failed" });
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
    await tx.delete(invoiceAcompteApplications).where(eq(invoiceAcompteApplications.devisId, devisId));
    await tx.execute(sql`SELECT set_config('app.allow_acompte_audit_delete', 'true', true)`);
    await tx.delete(acompteNoInvoicePayments).where(eq(acompteNoInvoicePayments.devisId, devisId));
  });
  await db.delete(invoices).where(eq(invoices.projectId, projectId));
  await db.delete(certificatPayments).where(eq(certificatPayments.certificatId, certificatId));
  await db.delete(certificats).where(eq(certificats.projectId, projectId));
  await db.delete(projectIntakeDocuments).where(eq(projectIntakeDocuments.projectId, projectId));
  await db.delete(devis).where(eq(devis.projectId, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("invoice opening-deposit application", () => {
  it("repairs a row missed while 0123's schema/tracker were already present, then no-ops on replay", async () => {
    // This is the production failure shape: 0123 installed the table and was
    // tracker-stamped, but its final data statement did not run.
    const tracker = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM drizzle.__drizzle_migrations
        WHERE created_at = 1788271200000`,
    );
    expect(tracker.rows[0]?.count).toBe("1");
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
      await tx.delete(invoiceAcompteApplications).where(eq(invoiceAcompteApplications.invoiceId, invoiceId));
    });
    await db.update(devis).set({ acompteState: "paid" }).where(eq(devis.id, devisId));
    await db.update(invoices).set({
      validationWarnings: [
        { field: "netAPayer", message: "Legacy non-deposit arithmetic" },
        { field: "amountTtc", message: "Must be retained" },
      ],
    }).where(eq(invoices.id, invoiceId));
    const [advisory] = await db.insert(documentAdvisories).values({
      invoiceId,
      code: "net_a_payer_mismatch",
      field: "netAPayer",
      severity: "warning",
      message: "Legacy non-deposit arithmetic",
    }).returning();

    await runRefireBackfill();

    const applications = await db.select().from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.invoiceId, invoiceId));
    expect(applications).toHaveLength(1);
    expect(applications[0].appliedTtc).toBe("1488.00");
    const [repairedDevis] = await db.select().from(devis).where(eq(devis.id, devisId));
    expect(repairedDevis.acompteState).toBe("applied");
    const [repairedInvoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(repairedInvoice.validationWarnings).toEqual([
      { field: "amountTtc", message: "Must be retained" },
    ]);
    const [resolvedAdvisory] = await db.select().from(documentAdvisories)
      .where(eq(documentAdvisories.id, advisory.id));
    expect(resolvedAdvisory.resolvedAt).not.toBeNull();

    const resolvedAt = resolvedAdvisory.resolvedAt;
    await runRefireBackfill();

    expect(await db.select().from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.invoiceId, invoiceId))).toHaveLength(1);
    const [replayedInvoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(replayedInvoice.validationWarnings).toEqual(repairedInvoice.validationWarnings);
    const [replayedAdvisory] = await db.select().from(documentAdvisories)
      .where(eq(documentAdvisories.id, advisory.id));
    expect(replayedAdvisory.resolvedAt).toEqual(resolvedAt);

    // Keep the pre-existing service-flow fixture independent of this
    // migration-repair reproduction.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
      await tx.delete(invoiceAcompteApplications).where(eq(invoiceAcompteApplications.invoiceId, invoiceId));
    });
    await db.update(devis).set({ acompteState: "pending" }).where(eq(devis.id, devisId));

    // Exact financial arithmetic is not enough when the source itself labels
    // a different project. The migration must preserve this mismatch for
    // review rather than trusting the invoice FK alone.
    const originalExtractedData = {
      documentType: "invoice",
      amountHt: 2075,
      amountTtc: 2490,
      netAPayer: 1002,
      acomptePaidAmountTtc: 1488,
      acomptePaidEvidenceText: "Acompte versé 1 488,00 €",
    };
    await db.update(projectIntakeDocuments).set({
      extractedData: { ...originalExtractedData, projectId: projectId + 1 },
    }).where(eq(projectIntakeDocuments.id, sourceId));
    await db.update(invoices).set({
      validationWarnings: [{ field: "netAPayer", message: "Contradictory provenance" }],
    }).where(eq(invoices.id, invoiceId));
    const [provenanceAdvisory] = await db.insert(documentAdvisories).values({
      invoiceId,
      code: "net_a_payer_mismatch",
      field: "netAPayer",
      severity: "warning",
      message: "Contradictory provenance",
    }).returning();

    await runRefireBackfill();

    expect(await db.select().from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.invoiceId, invoiceId))).toHaveLength(0);
    const [provenanceMismatchInvoice] = await db.select().from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(provenanceMismatchInvoice.validationWarnings).toEqual([
      { field: "netAPayer", message: "Contradictory provenance" },
    ]);
    const [openProvenanceAdvisory] = await db.select().from(documentAdvisories)
      .where(eq(documentAdvisories.id, provenanceAdvisory.id));
    expect(openProvenanceAdvisory.resolvedAt).toBeNull();

    await db.delete(documentAdvisories).where(eq(documentAdvisories.id, provenanceAdvisory.id));
    await db.update(projectIntakeDocuments).set({ extractedData: originalExtractedData })
      .where(eq(projectIntakeDocuments.id, sourceId));

    // Establish the immutable source-bound application first. Each malformed
    // value below must make all three migration statements safe no-ops for
    // that source: it cannot produce another application or clear review
    // state from the existing snapshot.
    await runRefireBackfill();
    expect(await db.select().from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.invoiceId, invoiceId))).toHaveLength(1);

    for (const [field, value] of [
      ["acomptePaidAmountTtc", "not-a-number"],
      ["netAPayer", "not-a-number"],
      ["retenueDeGarantie", "not-a-number"],
    ]) {
      const warning = { field: "netAPayer", message: `Malformed ${field}` };
      await db.update(projectIntakeDocuments).set({
        extractedData: { ...originalExtractedData, [field]: value },
      }).where(eq(projectIntakeDocuments.id, sourceId));
      await db.update(invoices).set({ validationWarnings: [warning] })
        .where(eq(invoices.id, invoiceId));
      const [malformedAdvisory] = await db.insert(documentAdvisories).values({
        invoiceId,
        code: "net_a_payer_mismatch",
        field: "netAPayer",
        severity: "warning",
        message: `Malformed ${field}`,
      }).returning();

      await runRefireBackfill();

      expect(await db.select().from(invoiceAcompteApplications)
        .where(eq(invoiceAcompteApplications.invoiceId, invoiceId))).toHaveLength(1);
      const [malformedInvoice] = await db.select().from(invoices)
        .where(eq(invoices.id, invoiceId));
      expect(malformedInvoice.validationWarnings).toEqual([warning]);
      const [openMalformedAdvisory] = await db.select().from(documentAdvisories)
        .where(eq(documentAdvisories.id, malformedAdvisory.id));
      expect(openMalformedAdvisory.resolvedAt).toBeNull();
      await db.delete(documentAdvisories).where(eq(documentAdvisories.id, malformedAdvisory.id));
    }

    await db.update(projectIntakeDocuments).set({ extractedData: originalExtractedData })
      .where(eq(projectIntakeDocuments.id, sourceId));
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.allow_acompte_application_delete', 'true', true)`);
      await tx.delete(invoiceAcompteApplications).where(eq(invoiceAcompteApplications.invoiceId, invoiceId));
    });
    await db.update(devis).set({ acompteState: "pending" }).where(eq(devis.id, devisId));
  });

  it("reconciles a paid C1, applies exact invoice arithmetic once, and preserves conflicts", async () => {
    expect(await reconcilePaidAcompteFromCertificatLedger(devisId)).toBe(true);
    const [afterReconcile] = await db.select().from(devis).where(eq(devis.id, devisId));
    expect(afterReconcile.acompteState).toBe("paid");

    await db.insert(acompteNoInvoicePayments).values({
      devisId,
      certificatId,
      sourceIntakeDocumentId: sourceId,
      sourceStorageKey: "tests/invoice-acompte/FR25.26-0144.pdf",
      sourceFileName: "FR25.26-0144.pdf",
      sourceContentFingerprint: "c".repeat(64),
      amountHt: "1240.00",
      amountTtc: "1488.00",
      paidAt: new Date("2026-08-31T10:00:00.000Z"),
      paymentReference: "AUDIT-IAA",
      evidenceText: "Acompte versé 1 488,00 €",
      confirmedByUserId: 1,
    });

    const [first, replay] = await Promise.all([
      applyInvoiceAcompteDeduction(invoiceId),
      applyInvoiceAcompteDeduction(invoiceId),
    ]);
    expect(first.outcome).toBe("applied");
    expect(replay.outcome).toBe("applied");
    const rows = await db.select().from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.invoiceId, invoiceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].appliedTtc).toBe("1488.00");
    expect(rows[0].invoiceGrossTtc).toBe("2490.00");
    expect(rows[0].invoiceNetPayableTtc).toBe("1002.00");
    expect(rows[0].paymentConflict).toBe(true);

    const [afterApply] = await db.select().from(devis).where(eq(devis.id, devisId));
    expect(afterApply.acompteState).toBe("applied");
    const summary = await getProjectFinancialSummary(projectId);
    expect(summary.success).toBe(true);
    if (!summary.success) throw new Error("unreachable");
    const devisSummary = summary.data.devis.find((row) => row.devisId === devisId)!;
    expect(devisSummary.certifiedTtc).toBe(2490);
    expect(devisSummary.acompteAppliedTtc).toBe(1488);
    expect(devisSummary.currentInvoiceBalanceTtc).toBe(1002);
    expect(devisSummary.resteARealiserTtc).toBe(0);
    expect(devisSummary.acomptePaymentConflict).toBe(true);

    await expect(
      db.update(invoiceAcompteApplications)
        .set({ appliedTtc: "1.00" })
        .where(eq(invoiceAcompteApplications.invoiceId, invoiceId)),
    ).rejects.toThrow(/Failed query: update "invoice_acompte_applications"/);
  });

  it("leaves mismatched extracted deposit amounts for review", async () => {
    const [mismatchDevis] = await db.insert(devis).values({
      projectId,
      contractorId,
      devisCode: `IAA-MISMATCH-${Date.now()}`,
      descriptionFr: "Mismatch",
      amountHt: "2075.00",
      amountTtc: "2490.00",
      acompteRequired: true,
      acompteAmountHt: "1240.00",
      acompteState: "paid",
      signOffStage: "client_signed_off",
      accountingState: "active",
    }).returning();
    const [mismatchCert] = await db.insert(certificats).values({
      projectId, contractorId, certificateRef: `C-IAA-M-${Date.now()}`,
      dateIssued: "2026-08-16", totalWorksHt: "1240.00", pvMvAdjustment: "0.00",
      previousPayments: "0.00", retenueGarantie: "0.00",
      cumulativeProrataDeduction: "0.00", periodProrataDeduction: "0.00",
      cumulativeAcompteRecoupment: "0.00", periodAcompteRecoupment: "0.00",
      tvaRatePercent: "20.00", tvaAutoliquidation: false, tvaRateSource: "documentary",
      netToPayHt: "1240.00", tvaAmount: "248.00", netToPayTtc: "1488.00",
      acompteDevisId: mismatchDevis.id, status: "paid",
    }).returning();
    await db.insert(certificatPayments).values({
      certificatId: mismatchCert.id, datePaid: "2026-08-17", amount: "1488.00",
    });
    const [mismatchSource] = await db.insert(projectIntakeDocuments).values({
      projectId,
      fileName: "mismatch.pdf",
      storageKey: "tests/invoice-acompte/mismatch.pdf",
      contentFingerprint: "d".repeat(64),
      extractedData: {
        documentType: "invoice",
        acomptePaidAmountTtc: 1400,
        acomptePaidEvidenceText: "Acompte versé",
        netAPayer: 1090,
      },
    }).returning();
    const [mismatchInvoice] = await db.insert(invoices).values({
      projectId, contractorId, devisId: mismatchDevis.id,
      sourceIntakeDocumentId: mismatchSource.id,
      invoiceNumber: `IAA-M-${Date.now()}`,
      amountHt: "2075.00", tvaAmount: "415.00", amountTtc: "2490.00",
    }).returning();
    await db.update(invoices).set({
      validationWarnings: [{ field: "netAPayer", message: "Real mismatch" }],
    }).where(eq(invoices.id, mismatchInvoice.id));
    const [mismatchAdvisory] = await db.insert(documentAdvisories).values({
      invoiceId: mismatchInvoice.id,
      code: "net_a_payer_mismatch",
      field: "netAPayer",
      severity: "warning",
      message: "Real mismatch",
    }).returning();
    await runRefireBackfill();
    await db.update(projectIntakeDocuments).set({
      extractedData: {
        documentType: "quotation",
        acomptePaidAmountTtc: 1488,
        acomptePaidEvidenceText: "Acompte versé",
        netAPayer: 1002,
      },
    }).where(eq(projectIntakeDocuments.id, mismatchSource.id));
    expect(await applyInvoiceAcompteDeduction(mismatchInvoice.id)).toMatchObject({
      outcome: "needs_review",
      code: "acompte_source_identity_mismatch",
    });
    await db.update(projectIntakeDocuments).set({
      extractedData: {
        documentType: "invoice",
        contractorId: contractorId + 1_000_000,
        acomptePaidAmountTtc: 1488,
        acomptePaidEvidenceText: "Acompte versé",
        netAPayer: 1002,
      },
    }).where(eq(projectIntakeDocuments.id, mismatchSource.id));
    expect(await applyInvoiceAcompteDeduction(mismatchInvoice.id)).toMatchObject({
      outcome: "needs_review",
      code: "acompte_source_identity_mismatch",
    });
    await db.update(projectIntakeDocuments).set({
      extractedData: {
        documentType: "invoice",
        acomptePaidAmountTtc: 1400,
        acomptePaidEvidenceText: "Acompte versé",
        netAPayer: 1090,
      },
    }).where(eq(projectIntakeDocuments.id, mismatchSource.id));
    const result = await applyInvoiceAcompteDeduction(mismatchInvoice.id);
    expect(result).toMatchObject({ outcome: "needs_review", code: "acompte_evidence_mismatch" });
    const [after] = await db.select().from(devis).where(eq(devis.id, mismatchDevis.id));
    expect(after.acompteState).toBe("paid");
    expect(await db.select().from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.devisId, mismatchDevis.id))).toHaveLength(0);
    const [mismatchAfter] = await db.select().from(invoices).where(eq(invoices.id, mismatchInvoice.id));
    expect(mismatchAfter.validationWarnings).toEqual([{ field: "netAPayer", message: "Real mismatch" }]);
    const [mismatchAdvisoryAfter] = await db.select().from(documentAdvisories)
      .where(eq(documentAdvisories.id, mismatchAdvisory.id));
    expect(mismatchAdvisoryAfter.resolvedAt).toBeNull();
  });

  it("revalidates stored invoice evidence on an empty confirm and freezes applied snapshots", async () => {
    // The preceding application is deliberately returned to draft solely to
    // exercise the generic review endpoint against its immutable snapshot.
    await db.update(invoices).set({ status: "draft" }).where(eq(invoices.id, invoiceId));
    const [obsoleteAdvisory] = await db.insert(documentAdvisories).values({
      invoiceId,
      code: "net_a_payer_mismatch",
      field: "netAPayer",
      severity: "warning",
      message: "Stale extracted TTC made net payable appear inconsistent",
    }).returning();

    const confirm = await fetch(`${base}/api/invoices/${invoiceId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(confirm.status).toBe(200);
    const confirmed = await confirm.json();
    expect(confirmed.status).toBe("pending");
    expect(confirmed.validationWarnings).toEqual([]);
    expect(confirmed.aiConfidence).toBe(100);
    const [resolvedAdvisory] = await db.select().from(documentAdvisories)
      .where(eq(documentAdvisories.id, obsoleteAdvisory.id));
    expect(resolvedAdvisory.resolvedAt).not.toBeNull();

    const patch = await fetch(`${base}/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountTtc: "2491.00" }),
    });
    expect(patch.status).toBe(409);
    expect((await patch.json()).code).toBe("invoice_acompte_application_immutable");

    await db.update(invoices).set({ status: "draft" }).where(eq(invoices.id, invoiceId));
    const deleteResponse = await fetch(`${base}/api/invoices/${invoiceId}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(409);
    expect((await deleteResponse.json()).code).toBe("invoice_acompte_application_immutable");
  });

  it("keeps a draft when deterministic revalidation finds a blocking error", async () => {
    const [invalidInvoice] = await db.insert(invoices).values({
      projectId,
      contractorId,
      devisId,
      invoiceNumber: `IAA-INVALID-${Date.now()}`,
      amountHt: "100.00",
      tvaAmount: "20.00",
      amountTtc: "120.00",
      status: "draft",
      aiExtractedData: {
        documentType: "invoice",
        autoLiquidation: true,
      },
    }).returning();

    const response = await fetch(`${base}/api/invoices/${invalidInvoice.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "invoice_validation_failed",
      reviewRequired: true,
      invoice: { id: invalidInvoice.id, status: "draft" },
    });
    expect(body.warnings.every((warning: { severity: string }) => warning.severity === "error")).toBe(true);

    const [stored] = await db.select().from(invoices).where(eq(invoices.id, invalidInvoice.id));
    expect(stored.status).toBe("draft");
    expect((stored.validationWarnings as Array<{ severity: string }>).some(
      (warning) => warning.severity === "error",
    )).toBe(true);
    expect(await db.select().from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.invoiceId, invalidInvoice.id))).toHaveLength(0);
  });
});