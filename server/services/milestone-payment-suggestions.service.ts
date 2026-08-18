/**
 * Task #617 — detect client "paid" confirmation replies for DESIGN-CONTRACT
 * MILESTONES and turn them into DRAFT payment suggestions, plus the atomic
 * human confirmation that flips the milestone to `paid`.
 *
 * Mirrors certificat-payment-suggestions.service.ts, deterministic by design:
 *  (a) the reply must arrive on the exact Gmail thread of the firm's own
 *      invoiced honoraires facture (thread id carried by the email document
 *      behind the CONFIRMED architect_fee_invoices evidence bound to the
 *      milestone),
 *  (b) the sender must be the project's client contact email,
 *  (c) the text must match the shared closed paid-phrase set. A client reply
 *      on the thread that does NOT match parks as `ambiguous` instead of
 *      being dropped.
 * Nothing is ever auto-recorded — the architect confirms (milestone → paid,
 * paidAt from the suggestion date, append-only audit on the evidence row) or
 * dismisses.
 */
import { db } from "../db";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { gmail_v1 } from "googleapis";
import {
  architectFeeInvoices,
  architectFeeInvoiceEvents,
  designContractMilestones,
  designContracts,
  emailDocuments,
  milestonePaymentSuggestions,
  projects,
  type MilestonePaymentSuggestion,
} from "@shared/schema";
import {
  detectPaidConfirmation,
  extractAddress,
  extractPlainText,
} from "./certificat-payment-suggestions.service";

export interface MilestoneReplyScanResult {
  scannedThreads: number;
  suggestionsCreated: number;
  ambiguousCreated: number;
  errors: number;
  scopeDenied?: boolean;
}

function headerOf(msg: gmail_v1.Schema$Message, name: string): string {
  const headers = msg.payload?.headers ?? [];
  return headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Confirmed architect-fee evidence rows whose milestone is `invoiced` and
 * whose captured email document carries a Gmail thread id — these are the
 * only threads a client "paid" reply can deterministically be tied to.
 */
async function getMilestoneThreadsAwaitingPayment() {
  return db
    .select({
      evidence: architectFeeInvoices,
      milestone: designContractMilestones,
      project: projects,
      emailThreadId: emailDocuments.emailThreadId,
      capturedMessageId: emailDocuments.emailMessageId,
    })
    .from(architectFeeInvoices)
    .innerJoin(designContractMilestones, eq(designContractMilestones.id, architectFeeInvoices.milestoneId))
    .innerJoin(projects, eq(projects.id, architectFeeInvoices.projectId))
    .innerJoin(emailDocuments, eq(emailDocuments.id, architectFeeInvoices.emailDocumentId))
    .where(
      and(
        eq(architectFeeInvoices.status, "confirmed"),
        eq(designContractMilestones.status, "invoiced"),
        isNotNull(emailDocuments.emailThreadId),
      ),
    );
}

/**
 * Scan the Gmail threads of invoiced-milestone honoraires factures for client
 * replies. Safe to re-run: already-seen message ids are skipped (unique on
 * email_message_id + ON CONFLICT DO NOTHING).
 */
export async function scanMilestoneInvoiceReplies(gmail: gmail_v1.Gmail): Promise<MilestoneReplyScanResult> {
  const result: MilestoneReplyScanResult = { scannedThreads: 0, suggestionsCreated: 0, ambiguousCreated: 0, errors: 0 };
  const awaiting = await getMilestoneThreadsAwaitingPayment();

  for (const row of awaiting) {
    const { evidence, milestone, project, emailThreadId, capturedMessageId } = row;
    if (!emailThreadId) continue;
    // Deterministic counterparty: only the project's client contact can
    // confirm. Without one on file we skip rather than guess.
    const counterparty = (project.clientContactEmail ?? "").trim().toLowerCase();
    if (!counterparty) continue;
    try {
      result.scannedThreads++;
      let thread;
      try {
        thread = await gmail.users.threads.get({ userId: "me", id: emailThreadId, format: "full" });
      } catch (err: any) {
        // 404 = thread not in THIS mailbox (scan runs once per linked inbox).
        if (err?.status === 404 || err?.code === 404 || err?.response?.status === 404) continue;
        // 403 = this client cannot read threads at all — abort the pass.
        if (err?.status === 403 || err?.code === 403 || err?.response?.status === 403) {
          result.errors++;
          result.scopeDenied = true;
          console.error(`[MilestonePaymentSuggestions] mailbox denied thread reads (403) — aborting scan pass (evidence ${evidence.id})`);
          return result;
        }
        throw err;
      }
      const messages = thread.data.messages ?? [];
      for (const msg of messages) {
        const messageId = msg.id;
        if (!messageId || messageId === capturedMessageId) continue;
        const sender = extractAddress(headerOf(msg, "From"));
        if (sender !== counterparty) continue;

        const detection = detectPaidConfirmation(extractPlainText(msg));
        const emailDate = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();
        const [created] = await db
          .insert(milestonePaymentSuggestions)
          .values({
            milestoneId: milestone.id,
            projectId: project.id,
            architectFeeInvoiceId: evidence.id,
            emailMessageId: messageId,
            emailThreadId,
            senderEmail: sender,
            emailDate,
            matchedExcerpt: detection.excerpt,
            suggestedAmount: milestone.amountTtc,
            suggestedDate: emailDate.toISOString().slice(0, 10),
            status: detection.matched ? "pending_review" : "ambiguous",
          })
          .onConflictDoNothing()
          .returning();
        if (created) {
          if (detection.matched) {
            result.suggestionsCreated++;
            console.log(
              `[MilestonePaymentSuggestions] milestone #${milestone.id} (${milestone.labelFr}): "paid" client reply from ${sender} → suggestion #${created.id}`,
            );
          } else {
            result.ambiguousCreated++;
            console.log(`[MilestonePaymentSuggestions] milestone #${milestone.id}: ambiguous client reply from ${sender} parked for review`);
          }
        }
      }
    } catch (err) {
      result.errors++;
      console.error(`[MilestonePaymentSuggestions] thread scan failed for evidence ${evidence.id} (milestone ${milestone.id}):`, err);
    }
  }
  return result;
}

export type MilestoneSuggestionConfirmOutcome =
  | { ok: true; suggestion: MilestonePaymentSuggestion; milestoneId: number }
  | { ok: false; status: number; code: string; message: string };

/**
 * Atomic human confirmation: ONE transaction locks the suggestion and the
 * milestone, requires an open suggestion and a not-yet-paid milestone in
 * `invoiced` (or `reached`) state, stamps `paid` with paidAt taken from the
 * SUGGESTED date (the client's email, never "now"), appends a note line,
 * dismisses other open suggestions for the milestone, and audits on the
 * bound evidence row when present.
 */
export async function confirmMilestonePaymentSuggestion(args: {
  suggestionId: number;
  userId: number;
  actor: string | null;
}): Promise<MilestoneSuggestionConfirmOutcome> {
  return db.transaction(async (tx): Promise<MilestoneSuggestionConfirmOutcome> => {
    // Lock ORDER matters: milestone first, then suggestion. Locking the
    // suggestion first deadlocks when two confirms race on sibling
    // suggestions of the same milestone (each holds its suggestion lock
    // while the winner waits to dismiss the loser's row).
    const [peek] = await tx
      .select({ milestoneId: milestonePaymentSuggestions.milestoneId })
      .from(milestonePaymentSuggestions)
      .where(eq(milestonePaymentSuggestions.id, args.suggestionId));
    if (!peek) return { ok: false, status: 404, code: "not_found", message: "Suggestion introuvable." };
    const [milestone] = await tx
      .select()
      .from(designContractMilestones)
      .where(eq(designContractMilestones.id, peek.milestoneId))
      .for("update");
    if (!milestone) return { ok: false, status: 404, code: "milestone_not_found", message: "Jalon introuvable." };
    // Ownership: only the architect who uploaded the contract may confirm
    // (mirrors the milestone PATCH route's owner gate).
    const [owningContract] = await tx
      .select({ uploadedByUserId: designContracts.uploadedByUserId })
      .from(designContracts)
      .where(eq(designContracts.id, milestone.contractId));
    if (!owningContract || owningContract.uploadedByUserId !== args.userId) {
      return { ok: false, status: 403, code: "not_owner", message: "Vous n'êtes pas le propriétaire de ce contrat." };
    }
    const [suggestion] = await tx
      .select()
      .from(milestonePaymentSuggestions)
      .where(eq(milestonePaymentSuggestions.id, args.suggestionId))
      .for("update");
    if (!suggestion) return { ok: false, status: 404, code: "not_found", message: "Suggestion introuvable." };
    if (suggestion.status !== "pending_review" && suggestion.status !== "ambiguous") {
      return { ok: false, status: 409, code: "already_reviewed", message: "Cette suggestion a déjà été traitée." };
    }
    if (milestone.status === "paid") {
      return { ok: false, status: 409, code: "already_paid", message: `Le jalon « ${milestone.labelFr} » est déjà payé.` };
    }
    if (milestone.status !== "invoiced" && milestone.status !== "reached") {
      return {
        ok: false,
        status: 409,
        code: "milestone_not_payable",
        message: `Le jalon « ${milestone.labelFr} » n'est ni facturé ni atteint (état : ${milestone.status}).`,
      };
    }

    const noteLine = `Paiement client confirmé le ${suggestion.suggestedDate} (email de ${suggestion.senderEmail}, suggestion n°${suggestion.id}).`;
    const updated = await tx
      .update(designContractMilestones)
      .set({
        status: "paid",
        paidAt: new Date(`${suggestion.suggestedDate}T00:00:00Z`),
        notes: milestone.notes ? `${milestone.notes}\n${noteLine}` : noteLine,
      })
      .where(and(eq(designContractMilestones.id, milestone.id), eq(designContractMilestones.status, milestone.status)))
      .returning();
    if (updated.length !== 1) throw new Error(`milestone ${milestone.id} paid flip affected ${updated.length} rows`);

    const [confirmed] = await tx
      .update(milestonePaymentSuggestions)
      .set({ status: "confirmed", reviewedBy: args.actor, reviewedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(milestonePaymentSuggestions.id, suggestion.id))
      .returning();

    // Duplicate open suggestions for the same milestone describe the same
    // transfer — leaving them open would offer a second paid flip.
    await tx
      .update(milestonePaymentSuggestions)
      .set({ status: "dismissed", reviewedBy: args.actor ?? "auto:milestone-paid", reviewedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(milestonePaymentSuggestions.milestoneId, milestone.id),
          ne(milestonePaymentSuggestions.id, suggestion.id),
          inArray(milestonePaymentSuggestions.status, ["pending_review", "ambiguous"]),
        ),
      );

    if (suggestion.architectFeeInvoiceId != null) {
      await tx.insert(architectFeeInvoiceEvents).values({
        architectFeeInvoiceId: suggestion.architectFeeInvoiceId,
        action: "milestone_paid",
        actor: args.actor,
        note: noteLine,
        details: { milestoneId: milestone.id, suggestionId: suggestion.id, suggestedDate: suggestion.suggestedDate },
      });
    }

    return { ok: true, suggestion: confirmed, milestoneId: milestone.id };
  });
}

export async function dismissMilestonePaymentSuggestion(args: {
  suggestionId: number;
  userId: number;
  actor: string | null;
}): Promise<MilestoneSuggestionConfirmOutcome> {
  const [updated] = await db
    .update(milestonePaymentSuggestions)
    .set({ status: "dismissed", reviewedBy: args.actor, reviewedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(milestonePaymentSuggestions.id, args.suggestionId),
        inArray(milestonePaymentSuggestions.status, ["pending_review", "ambiguous"]),
        // Owner-scoped: the suggestion's milestone must belong to a contract
        // uploaded by this user.
        sql`${milestonePaymentSuggestions.milestoneId} IN (
          SELECT m.id FROM design_contract_milestones m
          JOIN design_contracts c ON c.id = m.contract_id
          WHERE c.uploaded_by_user_id = ${args.userId}
        )`,
      ),
    )
    .returning();
  if (!updated) return { ok: false, status: 409, code: "not_open", message: "Suggestion introuvable, déjà traitée ou hors de votre périmètre." };
  return { ok: true, suggestion: updated, milestoneId: updated.milestoneId };
}

/**
 * Non-paid status transitions from the generic milestone PATCH. Conditional
 * on the status the caller read (compare-and-set), so a PATCH racing a paid
 * flip (manual or suggestion confirm) can never regress a terminal paid
 * state — the conditional UPDATE misses and the caller gets a 409.
 */
export async function transitionMilestoneStatus(args: {
  milestoneId: number;
  expectedStatus: string;
  toStatus: "pending" | "reached" | "invoiced";
  notes?: string | null;
  triggerEvent?: string;
}): Promise<
  | { ok: true; milestone: typeof designContractMilestones.$inferSelect }
  | { ok: false; status: number; code: string; message: string }
> {
  const set: Record<string, unknown> = { status: args.toStatus };
  if (args.toStatus === "reached") set.reachedAt = new Date();
  if (args.toStatus === "invoiced") set.invoicedAt = new Date();
  if (args.notes !== undefined) set.notes = args.notes;
  if (args.triggerEvent) set.triggerEvent = args.triggerEvent;
  const [updated] = await db
    .update(designContractMilestones)
    .set(set)
    .where(
      and(
        eq(designContractMilestones.id, args.milestoneId),
        eq(designContractMilestones.status, args.expectedStatus),
        ne(designContractMilestones.status, "paid"),
      ),
    )
    .returning();
  if (!updated) {
    return {
      ok: false,
      status: 409,
      code: "MILESTONE_STATUS_CHANGED",
      message: "Le jalon a changé d'état entre-temps — rechargez la page.",
    };
  }
  return { ok: true, milestone: updated };
}

export type ManualPaidOutcome =
  | { ok: true; milestone: typeof designContractMilestones.$inferSelect }
  | { ok: false; status: number; code: string; message: string };

/**
 * Manual "Mark paid" — the same money-state transition as a suggestion
 * confirm, so it takes the SAME milestone row lock and a conditional
 * (status-guarded) update, and dismisses open suggestions inside the same
 * transaction. A manual flip racing a suggestion confirm therefore either
 * loses cleanly (409 already_paid, never overwriting an email-derived
 * paidAt) or wins with suggestions dismissed atomically.
 */
export async function markMilestonePaidManually(args: {
  milestoneId: number;
  actor: string | null;
}): Promise<ManualPaidOutcome> {
  return db.transaction(async (tx): Promise<ManualPaidOutcome> => {
    const [milestone] = await tx
      .select()
      .from(designContractMilestones)
      .where(eq(designContractMilestones.id, args.milestoneId))
      .for("update");
    if (!milestone) return { ok: false, status: 404, code: "not_found", message: "Jalon introuvable." };
    if (milestone.status === "paid") {
      return { ok: false, status: 409, code: "already_paid", message: `Le jalon « ${milestone.labelFr} » est déjà payé.` };
    }
    if (milestone.status !== "invoiced" && milestone.status !== "reached") {
      return {
        ok: false,
        status: 409,
        code: "milestone_not_payable",
        message: `Le jalon ne peut pas être marqué payé depuis l'état « ${milestone.status} ».`,
      };
    }
    const updated = await tx
      .update(designContractMilestones)
      .set({ status: "paid", paidAt: new Date() })
      .where(and(eq(designContractMilestones.id, milestone.id), eq(designContractMilestones.status, milestone.status)))
      .returning();
    if (updated.length !== 1) throw new Error(`milestone ${milestone.id} manual paid flip affected ${updated.length} rows`);
    // Open suggestions describe this now-settled payment; dismiss them in
    // the same tx so a failure can't leave a paid milestone with open rows.
    await tx
      .update(milestonePaymentSuggestions)
      .set({ status: "dismissed", reviewedBy: args.actor ?? "auto:milestone-paid", reviewedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(milestonePaymentSuggestions.milestoneId, milestone.id),
          inArray(milestonePaymentSuggestions.status, ["pending_review", "ambiguous"]),
        ),
      );
    return { ok: true, milestone: updated[0] };
  });
}

/** Open suggestions with display context, scoped to contracts the user owns. */
export async function listOpenMilestonePaymentSuggestions(userId: number, projectId?: number) {
  const rows = await db
    .select({
      suggestion: milestonePaymentSuggestions,
      milestoneLabel: designContractMilestones.labelFr,
      milestoneSequence: designContractMilestones.sequence,
      milestoneStatus: designContractMilestones.status,
      projectName: projects.name,
      projectCode: projects.code,
    })
    .from(milestonePaymentSuggestions)
    .innerJoin(designContractMilestones, eq(designContractMilestones.id, milestonePaymentSuggestions.milestoneId))
    .innerJoin(designContracts, eq(designContracts.id, designContractMilestones.contractId))
    .innerJoin(projects, eq(projects.id, milestonePaymentSuggestions.projectId))
    .where(
      and(
        inArray(milestonePaymentSuggestions.status, ["pending_review", "ambiguous"]),
        eq(designContracts.uploadedByUserId, userId),
        ...(projectId != null ? [eq(milestonePaymentSuggestions.projectId, projectId)] : []),
      ),
    )
    .orderBy(milestonePaymentSuggestions.createdAt);
  return rows.map((r) => ({
    ...r.suggestion,
    milestoneLabel: r.milestoneLabel,
    milestoneSequence: r.milestoneSequence,
    milestoneStatus: r.milestoneStatus,
    projectName: r.projectName,
    projectCode: r.projectCode,
  }));
}
