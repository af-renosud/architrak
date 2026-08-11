/**
 * Task #426 — atomic confirmation of a caught architect fee invoice.
 *
 * When the operator confirms a parked `architect_fee_invoice` against a
 * project + design-contract milestone, ONE transaction (with row locks on
 * the evidence, the milestone, and the candidate fee entries):
 *   - binds the evidence row (status confirmed + project/milestone/feeEntry),
 *   - transitions the milestone to `invoiced` with `invoicedAt` taken from
 *     the EXTRACTED issue date (never "today"; `paid` stays with the
 *     Pennylane paid-poller),
 *   - records/attaches the fee entry with the EXTRACTED ref + date via
 *     `markFeeEntryInvoicedTx`,
 *   - appends an immutable review-decision audit event.
 *
 * Concurrency: the evidence and milestone rows are read `FOR UPDATE`
 * inside the transaction, so two simultaneous confirms serialize — the
 * second observes the committed state and resolves as replay / refusal,
 * never a double-record.
 *
 * Pennylane reconciliation (must never double-record an invoice that
 * already exists via the push flow):
 *   1. match project fee entries by NORMALIZED invoice number/ref
 *      (pennylaneInvoiceNumber — human number captured at push — or the
 *      legacy manual pennylaneInvoiceRef);
 *   2. else same project + exact rounded HT amount, but ONLY among
 *      Pennylane-backed entries (pennylaneInvoiceId set) — an unrelated
 *      local/manual entry with a coincidentally equal amount must never be
 *      consumed;
 *   3. a matched entry that already carries a DIFFERENT Pennylane
 *      number/ref, or an ambiguous amount match, PARKS the evidence for
 *      review instead of guessing.
 *
 * Evidence without a valid extracted issue date is REFUSED — the service
 * never fabricates an invoice date from server time.
 *
 * Idempotent on replay: re-confirming an already-confirmed evidence with
 * the same binding is a no-op success (audited as `replayed`).
 */

import { db } from "../db";
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
import type { ArchitectFeeInvoice, FeeEntry } from "@shared/schema";
import { normalizeInvoiceRef } from "@shared/architect-fee-match";
import { roundCurrency } from "@shared/financial-utils";
import { markFeeEntryInvoicedTx } from "./fee-calculation.service";

export type ConfirmOutcome =
  | {
      ok: true;
      replayed: boolean;
      evidence: ArchitectFeeInvoice;
      feeEntryId: number;
      milestoneId: number;
      reconciliation: "attached_by_ref" | "attached_by_amount" | "created";
    }
  | { ok: false; status: number; code: string; message: string; parked?: boolean };

export async function confirmArchitectFeeInvoice(args: {
  evidenceId: number;
  projectId: number;
  milestoneId: number;
  actor: string | null;
}): Promise<ConfirmOutcome> {
  return await db.transaction(async (tx): Promise<ConfirmOutcome> => {
      // ── Lock the evidence row: concurrent confirms serialize here. ──
      const [evidence] = await tx
        .select()
        .from(architectFeeInvoices)
        .where(eq(architectFeeInvoices.id, args.evidenceId))
        .for("update");
      if (!evidence) {
        return ({ ok: false, status: 404, code: "not_found", message: "Facture introuvable." });
      }

      // Idempotent replay: same binding already confirmed → success, audited.
      if (evidence.status === "confirmed") {
        if (
          evidence.projectId === args.projectId &&
          evidence.milestoneId === args.milestoneId &&
          evidence.feeEntryId != null
        ) {
          await tx.insert(architectFeeInvoiceEvents).values({
            architectFeeInvoiceId: evidence.id,
            action: "replayed",
            actor: args.actor,
            note: "Confirmation replay — binding already recorded, no writes.",
            details: { projectId: args.projectId, milestoneId: args.milestoneId, feeEntryId: evidence.feeEntryId },
          });
          return ({
            ok: true,
            replayed: true,
            evidence,
            feeEntryId: evidence.feeEntryId,
            milestoneId: args.milestoneId,
            reconciliation: "attached_by_ref",
          });
        }
        return ({
          ok: false,
          status: 409,
          code: "already_confirmed",
          message: `Cette facture est déjà confirmée (projet #${evidence.projectId}, jalon #${evidence.milestoneId}).`,
        });
      }
      if (evidence.status === "dismissed") {
        return ({ ok: false, status: 409, code: "dismissed", message: "Cette facture a été écartée." });
      }

      // ── Server-authoritative date: EXTRACTED issue date or refuse. ──
      if (!evidence.issueDate) {
        return ({
          ok: false,
          status: 409,
          code: "missing_issue_date",
          message: "Date d'émission absente de la facture — impossible de dater l'écriture. Complétez la pièce avant confirmation.",
        });
      }
      const dateInvoiced = evidence.issueDate;

      const [project] = await tx.select().from(projects).where(eq(projects.id, args.projectId));
      if (!project) {
        return ({ ok: false, status: 404, code: "project_not_found", message: "Projet introuvable." });
      }
      const [contract] = await tx.select().from(designContracts).where(eq(designContracts.projectId, args.projectId));
      if (!contract) {
        return ({ ok: false, status: 409, code: "no_contract", message: "Ce projet n'a pas de contrat de conception." });
      }
      // ── Lock the milestone row too. ──
      const [milestone] = await tx
        .select()
        .from(designContractMilestones)
        .where(eq(designContractMilestones.id, args.milestoneId))
        .for("update");
      if (!milestone || milestone.contractId !== contract.id) {
        return ({ ok: false, status: 409, code: "milestone_mismatch", message: "Le jalon n'appartient pas au contrat de ce projet." });
      }
      if (milestone.status === "paid" || milestone.status === "invoiced") {
        return ({
          ok: false,
          status: 409,
          code: "milestone_already_" + milestone.status,
          message: `Le jalon « ${milestone.labelFr} » est déjà ${milestone.status === "paid" ? "payé" : "facturé"}.`,
        });
      }

      const refNorm = evidence.invoiceNumberNormalized ?? normalizeInvoiceRef(evidence.invoiceNumber);
      const amountHt = evidence.amountHt != null ? roundCurrency(Number(evidence.amountHt)) : null;

      // ── Reconciliation candidates: lock the project's fee entries. ──
      const projectFees = await tx.select().from(fees).where(eq(fees.projectId, args.projectId));
      const entries: FeeEntry[] = projectFees.length
        ? await tx
            .select()
            .from(feeEntries)
            .where(inArray(feeEntries.feeId, projectFees.map((f) => f.id)))
            .for("update")
        : [];
      const entryRef = (e: FeeEntry): string | null =>
        normalizeInvoiceRef(e.pennylaneInvoiceNumber) ?? normalizeInvoiceRef(e.pennylaneInvoiceRef);

      let matched: FeeEntry | undefined;
      let reconciliation: "attached_by_ref" | "attached_by_amount" | "created" = "created";

      if (refNorm) {
        const refMatches = entries.filter((e) => entryRef(e) === refNorm);
        if (refMatches.length > 1) {
          return await park(tx, evidence, args.actor, "ref_ambiguous", `Plusieurs écritures d'honoraires portent la référence ${evidence.invoiceNumber}.`);
        }
        if (refMatches.length === 1) {
          matched = refMatches[0];
          reconciliation = "attached_by_ref";
        }
      }

      if (!matched && amountHt != null) {
        // Amount fallback attaches ONLY to Pennylane-backed entries — an
        // unrelated local/manual entry with the same amount must never be
        // silently consumed by an inbound document.
        const backed = entries.filter(
          (e) => e.pennylaneInvoiceId != null && roundCurrency(parseFloat(e.feeAmount)) === amountHt,
        );
        const conflicting = backed.find((e) => {
          const r = entryRef(e);
          return r != null && refNorm != null && r !== refNorm;
        });
        const clean = backed.filter((e) => {
          const r = entryRef(e);
          return r == null || refNorm == null || r === refNorm;
        });
        if (clean.length > 1) {
          return await park(tx, evidence, args.actor, "amount_ambiguous", `Plusieurs écritures Pennylane de ${amountHt.toFixed(2)} € HT correspondent — rapprochement manuel requis.`);
        }
        if (clean.length === 1) {
          matched = clean[0];
          reconciliation = "attached_by_amount";
        } else if (conflicting) {
          return await park(tx, evidence, args.actor, "ref_conflict", `Une écriture Pennylane de ${amountHt.toFixed(2)} € HT porte déjà une autre référence (${conflicting.pennylaneInvoiceNumber ?? conflicting.pennylaneInvoiceRef}).`);
        }
      }

      if (matched) {
        // Never rebind an entry already bound to ANOTHER confirmed evidence.
        const [boundTo] = await tx
          .select()
          .from(architectFeeInvoices)
          .where(eq(architectFeeInvoices.feeEntryId, matched.id));
        if (boundTo && boundTo.id !== evidence.id && boundTo.status === "confirmed") {
          return await park(tx, evidence, args.actor, "entry_already_bound", `L'écriture d'honoraires #${matched.id} est déjà liée à la facture confirmée #${boundTo.id}.`);
        }
      }

      // ── Writes ──
      let feeEntryId: number;
      if (matched) {
        if (matched.status === "pending") {
          const res = await markFeeEntryInvoicedTx(tx, matched.id, {
            dateInvoiced,
            pennylaneInvoiceRef: matched.pennylaneInvoiceRef ?? evidence.invoiceNumber,
            pennylaneInvoiceNumber: evidence.invoiceNumber,
          });
          if (!res.ok) throw new Error(`fee entry ${matched.id} transition failed: ${res.reason}`);
        } else if (!matched.pennylaneInvoiceNumber && evidence.invoiceNumber) {
          // Already invoiced via the Pennylane push flow — ATTACH only:
          // backfill the human number, no state or money change.
          await tx
            .update(feeEntries)
            .set({ pennylaneInvoiceNumber: evidence.invoiceNumber })
            .where(eq(feeEntries.id, matched.id));
        }
        feeEntryId = matched.id;
      } else {
        if (amountHt == null) {
          return ({ ok: false, status: 409, code: "no_amount", message: "Montant HT manquant sur la facture — impossible d'enregistrer l'écriture." });
        }
        // Hang the entry off the project's conception fee (created by the
        // design-contract confirm flow); create it from contract totals if
        // an old project predates that flow.
        let fee = projectFees.find((f) => f.feeType === "conception");
        if (!fee) {
          const contractHt = roundCurrency(Number(contract.totalTtc) / 1.2);
          [fee] = await tx
            .insert(fees)
            .values({
              projectId: args.projectId,
              feeType: "conception",
              baseAmountHt: contractHt.toFixed(2),
              feeAmountHt: contractHt.toFixed(2),
              invoicedAmount: "0.00",
              remainingAmount: contractHt.toFixed(2),
              status: "pending",
            })
            .returning();
        }
        const [entry] = await tx
          .insert(feeEntries)
          .values({
            feeId: fee.id,
            baseHt: amountHt.toFixed(2),
            feeRate: "100.00",
            feeAmount: amountHt.toFixed(2),
            status: "pending",
          })
          .returning();
        const res = await markFeeEntryInvoicedTx(tx, entry.id, {
          dateInvoiced,
          pennylaneInvoiceRef: evidence.invoiceNumber,
          pennylaneInvoiceNumber: evidence.invoiceNumber,
        });
        if (!res.ok) throw new Error(`fresh fee entry ${entry.id} transition failed: ${res.reason}`);
        feeEntryId = entry.id;
      }

      // Milestone → invoiced, dated from the document. Compare-and-set on
      // the status we validated under lock. PDF stays attached via the
      // bound evidence row; the note makes it findable by hand.
      const noteLine = `Facture ${evidence.invoiceNumber ?? "?"} du ${dateInvoiced} (pièce n°${evidence.id}${evidence.fileName ? ` — ${evidence.fileName}` : ""}).`;
      const milestoneUpdated = await tx
        .update(designContractMilestones)
        .set({
          status: "invoiced",
          invoicedAt: new Date(`${dateInvoiced}T00:00:00Z`),
          notes: milestone.notes ? `${milestone.notes}\n${noteLine}` : noteLine,
        })
        .where(eq(designContractMilestones.id, milestone.id))
        .returning();
      if (milestoneUpdated.length !== 1) throw new Error(`milestone ${milestone.id} update affected ${milestoneUpdated.length} rows`);

      const [updatedEvidence] = await tx
        .update(architectFeeInvoices)
        .set({
          status: "confirmed",
          projectId: args.projectId,
          milestoneId: milestone.id,
          feeEntryId,
          reviewedBy: args.actor,
          reviewedAt: new Date(),
        })
        .where(eq(architectFeeInvoices.id, evidence.id))
        .returning();

      await tx.insert(architectFeeInvoiceEvents).values({
        architectFeeInvoiceId: evidence.id,
        action: "confirmed",
        actor: args.actor,
        note: noteLine,
        details: { projectId: args.projectId, milestoneId: milestone.id, feeEntryId, reconciliation, dateInvoiced },
      });

      return { ok: true, replayed: false, evidence: updatedEvidence, feeEntryId, milestoneId: milestone.id, reconciliation };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Conflict path: evidence STAYS pending_review; the conflict is audited and
 * surfaced in the notes. Writes ride on the SAME transaction (which holds
 * the row locks) and are committed by the caller returning normally —
 * refusals never roll back their own audit trail.
 */
async function park(
  tx: Tx,
  evidence: ArchitectFeeInvoice,
  actor: string | null,
  code: string,
  message: string,
): Promise<ConfirmOutcome> {
  await tx.insert(architectFeeInvoiceEvents).values({
    architectFeeInvoiceId: evidence.id,
    action: "conflict_parked",
    actor,
    note: message,
    details: { code },
  });
  await tx
    .update(architectFeeInvoices)
    .set({ notes: evidence.notes ? `${evidence.notes}\n⚠ ${message}` : `⚠ ${message}` })
    .where(eq(architectFeeInvoices.id, evidence.id));
  console.warn(`[ArchitectFeeInvoiceConfirm] evidence ${evidence.id} parked (${code}): ${message}`);
  return { ok: false, status: 409, code, message, parked: true };
}
