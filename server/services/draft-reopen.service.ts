/**
 * Task #346 — transactional "reopen for review" (pending → draft).
 *
 * The eligibility rules are pure and live in draft-reopen.rules.ts; this
 * module wraps them in a serialised transaction so a reopen can never race
 * a concurrent confirm/approve:
 *
 *   - the target row is locked FOR UPDATE before its status is checked, so
 *     an in-flight approval (which also locks FOR UPDATE, see
 *     invoice-approval.service.ts) either completes first (reopen then sees
 *     "approved" and refuses) or waits and finds "draft" (refuses);
 *   - downstream counts (invoices / situations for a devis) are read inside
 *     the same transaction;
 *   - the append-only draft_reopen_events audit row is written in the same
 *     transaction as the status flip, so the trace can never be lost.
 *
 * Reopening intentionally preserves the current (possibly user-corrected)
 * values — RE-SCRAPE is the path for a fresh AI extraction.
 */
import { db } from "../db";
import { eq, sql, count } from "drizzle-orm";
import {
  devis as devisTable,
  invoices as invoicesTable,
  situations as situationsTable,
  draftReopenEvents,
} from "@shared/schema";
import { evaluateDevisReopen, evaluateInvoiceReopen } from "./draft-reopen.rules";

export interface ReopenResult {
  success: boolean;
  status: number;
  data: Record<string, unknown>;
}

export async function reopenDevisDraft(devisId: number, reopenedBy: string | null): Promise<ReopenResult> {
  return await db.transaction(async (tx) => {
    // Pessimistic lock to serialise against concurrent confirm/stage moves.
    await tx.execute(sql`SELECT 1 FROM devis WHERE id = ${devisId} FOR UPDATE`);
    const [locked] = await tx.select().from(devisTable).where(eq(devisTable.id, devisId));
    if (!locked) {
      return { success: false, status: 404, data: { message: "Devis not found" } };
    }

    const [{ value: invoiceCount }] = await tx
      .select({ value: count() })
      .from(invoicesTable)
      .where(eq(invoicesTable.devisId, devisId));
    const [{ value: situationCount }] = await tx
      .select({ value: count() })
      .from(situationsTable)
      .where(eq(situationsTable.devisId, devisId));

    const verdict = evaluateDevisReopen({
      status: locked.status,
      signOffStage: locked.signOffStage,
      invoiceCount: Number(invoiceCount),
      situationCount: Number(situationCount),
    });
    if (!verdict.ok) {
      return { success: false, status: 409, data: { message: verdict.reason } };
    }

    const [updated] = await tx
      .update(devisTable)
      .set({ status: "draft" })
      .where(eq(devisTable.id, devisId))
      .returning();

    await tx.insert(draftReopenEvents).values({
      entityType: "devis",
      entityId: devisId,
      previousStatus: locked.status,
      reopenedBy,
    });

    return { success: true, status: 200, data: { devis: updated } };
  });
}

export async function reopenInvoiceDraft(invoiceId: number, reopenedBy: string | null): Promise<ReopenResult> {
  return await db.transaction(async (tx) => {
    // Same lock the approval path takes — the two transitions serialise.
    await tx.execute(sql`SELECT 1 FROM invoices WHERE id = ${invoiceId} FOR UPDATE`);
    const [locked] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
    if (!locked) {
      return { success: false, status: 404, data: { message: "Invoice not found" } };
    }

    const verdict = evaluateInvoiceReopen({ status: locked.status });
    if (!verdict.ok) {
      return { success: false, status: 409, data: { message: verdict.reason } };
    }

    const [updated] = await tx
      .update(invoicesTable)
      .set({ status: "draft" })
      .where(eq(invoicesTable.id, invoiceId))
      .returning();

    await tx.insert(draftReopenEvents).values({
      entityType: "invoice",
      entityId: invoiceId,
      previousStatus: locked.status,
      reopenedBy,
    });

    return { success: true, status: 200, data: { invoice: updated } };
  });
}
