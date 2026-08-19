import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import {
  architectFeeInvoiceEvents,
  architectFeeInvoices,
  designContractMilestones,
  designContracts,
  feeEntries,
  fees,
  milestonePaymentSuggestions,
  type ArchitectFeeInvoice,
  type FeeEntry,
} from "@shared/schema";
import { normalizeInvoiceRef } from "@shared/architect-fee-match";
import { roundCurrency } from "@shared/financial-utils";
import { markFeeEntryInvoicedTx } from "./fee-calculation.service";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ManualMilestoneInvoiceOutcome =
  | {
      ok: true;
      milestone: typeof designContractMilestones.$inferSelect;
      evidence: ArchitectFeeInvoice;
      feeEntryId: number;
      reconciliation: "existing_evidence" | "attached_by_ref" | "created";
    }
  | { ok: false; status: number; code: string; message: string };

type ManualInvoiceMode = "record_invoice" | "complete_paid_details";

export async function recordManualMilestoneInvoice(args: {
  milestoneId: number;
  userId: number;
  actor: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  notes?: string | null;
}): Promise<ManualMilestoneInvoiceOutcome> {
  return persistManualMilestoneInvoice({ ...args, mode: "record_invoice" });
}

export async function completePaidMilestoneDetails(args: {
  milestoneId: number;
  userId: number;
  actor: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  paymentDate: string;
  notes?: string | null;
}): Promise<ManualMilestoneInvoiceOutcome> {
  return persistManualMilestoneInvoice({ ...args, mode: "complete_paid_details" });
}

async function persistManualMilestoneInvoice(args: {
  milestoneId: number;
  userId: number;
  actor: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  paymentDate?: string;
  notes?: string | null;
  mode: ManualInvoiceMode;
}): Promise<ManualMilestoneInvoiceOutcome> {
  const invoiceNumber = args.invoiceNumber.trim();
  const refNorm = normalizeInvoiceRef(invoiceNumber);
  if (!refNorm) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_INVOICE_NUMBER",
      message: "Le numéro de facture doit contenir au moins une lettre ou un chiffre.",
    };
  }

  try {
    return await db.transaction(async (tx): Promise<ManualMilestoneInvoiceOutcome> => {
      // Serialise two manual recordings of the same normalized reference even
      // when neither transaction can see a row yet. The partial UNIQUE index on
      // architect_fee_invoices remains the final database-level guard.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"milestone-invoice:" + refNorm}))`);

      // Match the caught-invoice confirmation lock order: evidence/ref first,
      // milestone second, fee entries last. This prevents a manual record from
      // deadlocking with a Gmail confirmation for the same invoice.
      const matchingEvidence = await tx
        .select()
        .from(architectFeeInvoices)
        .where(
          and(
            eq(architectFeeInvoices.invoiceNumberNormalized, refNorm),
            ne(architectFeeInvoices.status, "dismissed"),
          ),
        )
        .for("update");

      const [milestone] = await tx
        .select()
        .from(designContractMilestones)
        .where(eq(designContractMilestones.id, args.milestoneId))
        .for("update");
      if (!milestone) {
        return { ok: false, status: 404, code: "MILESTONE_NOT_FOUND", message: "Jalon introuvable." };
      }

      const [contract] = await tx
        .select()
        .from(designContracts)
        .where(eq(designContracts.id, milestone.contractId));
      if (!contract) {
        return { ok: false, status: 404, code: "CONTRACT_NOT_FOUND", message: "Contrat introuvable." };
      }
      if (contract.uploadedByUserId !== args.userId) {
        return {
          ok: false,
          status: 403,
          code: "NOT_CONTRACT_OWNER",
          message: "Vous n'êtes pas le propriétaire de ce contrat.",
        };
      }

      if (args.mode === "record_invoice" && milestone.status !== "reached") {
        return {
          ok: false,
          status: 409,
          code: "MILESTONE_NOT_REACHED",
          message: `Une facture ne peut être enregistrée que pour un jalon atteint (état actuel : ${milestone.status}).`,
        };
      }
      if (args.mode === "complete_paid_details" && milestone.status !== "paid") {
        return {
          ok: false,
          status: 409,
          code: "MILESTONE_NOT_PAID",
          message: `Les détails historiques ne peuvent être complétés que sur un jalon payé (état actuel : ${milestone.status}).`,
        };
      }

      const milestoneEvidence = await tx
        .select()
        .from(architectFeeInvoices)
        .where(
          and(
            eq(architectFeeInvoices.milestoneId, milestone.id),
            eq(architectFeeInvoices.status, "confirmed"),
          ),
        )
        .for("update");
      if (milestoneEvidence.length > 1) {
        return {
          ok: false,
          status: 409,
          code: "MILESTONE_EVIDENCE_AMBIGUOUS",
          message: "Plusieurs factures sont déjà liées à ce jalon — un rapprochement manuel est requis.",
        };
      }
      const existingEvidence = milestoneEvidence[0];

      const conflictingEvidence = matchingEvidence.find((row) => row.id !== existingEvidence?.id);
      if (conflictingEvidence) {
        return {
          ok: false,
          status: 409,
          code: "DUPLICATE_INVOICE_NUMBER",
          message: `La facture ${invoiceNumber} est déjà enregistrée sur un autre jalon ou projet.`,
        };
      }
      if (
        existingEvidence?.invoiceNumberNormalized &&
        existingEvidence.invoiceNumberNormalized !== refNorm
      ) {
        return {
          ok: false,
          status: 409,
          code: "MILESTONE_INVOICE_NUMBER_CONFLICT",
          message: `Ce jalon est déjà lié à la facture ${existingEvidence.invoiceNumber ?? "existante"}.`,
        };
      }

      const projectFees = await tx
        .select()
        .from(fees)
        .where(eq(fees.projectId, contract.projectId))
        .orderBy(fees.id)
        .for("update");
      const projectEntries: FeeEntry[] = projectFees.length
        ? await tx
            .select()
            .from(feeEntries)
            .where(inArray(feeEntries.feeId, projectFees.map((fee) => fee.id)))
            .for("update")
        : [];

      const bearingEntries = await lockEntriesBearingRef(tx, refNorm);
      let target = existingEvidence?.feeEntryId != null
        ? projectEntries.find((entry) => entry.id === existingEvidence.feeEntryId)
        : undefined;
      let reconciliation: "existing_evidence" | "attached_by_ref" | "created" =
        target ? "existing_evidence" : "created";

      if (existingEvidence?.feeEntryId != null && !target) {
        return {
          ok: false,
          status: 409,
          code: "LINKED_ENTRY_OUTSIDE_PROJECT",
          message: "L'écriture déjà liée à cette facture n'appartient plus au projet.",
        };
      }

      const foreignBearing = bearingEntries.find(
        (entry) => !projectEntries.some((projectEntry) => projectEntry.id === entry.id),
      );
      if (foreignBearing) {
        return {
          ok: false,
          status: 409,
          code: "DUPLICATE_INVOICE_NUMBER",
          message: `La facture ${invoiceNumber} est déjà portée par une écriture d'un autre projet.`,
        };
      }

      if (!target) {
        const localMatches = bearingEntries.filter((entry) =>
          projectEntries.some((projectEntry) => projectEntry.id === entry.id),
        );
        if (localMatches.length > 1) {
          return {
            ok: false,
            status: 409,
            code: "INVOICE_ENTRY_AMBIGUOUS",
            message: `Plusieurs écritures portent déjà la référence ${invoiceNumber}.`,
          };
        }
        if (localMatches.length === 1) {
          target = localMatches[0];
          reconciliation = "attached_by_ref";
        }
      }

      if (target) {
        const targetNorm =
          normalizeInvoiceRef(target.pennylaneInvoiceNumber) ??
          normalizeInvoiceRef(target.pennylaneInvoiceRef);
        if (targetNorm && targetNorm !== refNorm) {
          return {
            ok: false,
            status: 409,
            code: "LINKED_ENTRY_REF_CONFLICT",
            message: "L'écriture liée porte déjà un autre numéro de facture.",
          };
        }
        const [boundElsewhere] = await tx
          .select()
          .from(architectFeeInvoices)
          .where(
            and(
              eq(architectFeeInvoices.feeEntryId, target.id),
              eq(architectFeeInvoices.status, "confirmed"),
              ...(existingEvidence ? [ne(architectFeeInvoices.id, existingEvidence.id)] : []),
            ),
          )
          .for("update");
        if (boundElsewhere) {
          return {
            ok: false,
            status: 409,
            code: "FEE_ENTRY_ALREADY_BOUND",
            message: "Cette écriture d'honoraires est déjà liée à une autre facture confirmée.",
          };
        }
      }

      const amountTtc = roundCurrency(Number(milestone.amountTtc));
      const htFactor = resolveHtFactor(contract);
      if (!target && htFactor == null) {
        return {
          ok: false,
          status: 409,
          code: "MILESTONE_HT_UNAVAILABLE",
          message:
            "Le contrat ne contient pas assez d'informations de TVA pour créer l'écriture HT. Complétez le contrat ou rapprochez une écriture existante.",
        };
      }
      const amountHt = target
        ? roundCurrency(Number(target.feeAmount))
        : roundCurrency(amountTtc * htFactor!);

      if (!target) {
        let parentFee = projectFees.find((fee) => fee.feeType === "conception");
        if (!parentFee) {
          const contractHt = roundCurrency(Number(contract.totalTtc) * htFactor!);
          [parentFee] = await tx
            .insert(fees)
            .values({
              projectId: contract.projectId,
              feeType: "conception",
              baseAmountHt: contractHt.toFixed(2),
              feeAmountHt: contractHt.toFixed(2),
              invoicedAmount: "0.00",
              remainingAmount: contractHt.toFixed(2),
              status: "pending",
            })
            .returning();
        }
        [target] = await tx
          .insert(feeEntries)
          .values({
            feeId: parentFee.id,
            baseHt: amountHt.toFixed(2),
            feeRate: "100.00",
            feeAmount: amountHt.toFixed(2),
            status: "pending",
          })
          .returning();
      }

      if (target.status === "pending") {
        const invoiced = await markFeeEntryInvoicedTx(tx, target.id, {
          dateInvoiced: args.invoiceDate,
          pennylaneInvoiceRef: invoiceNumber,
          pennylaneInvoiceNumber: invoiceNumber,
        });
        if (!invoiced.ok) {
          throw new Error(`fee entry ${target.id} invoice transition failed: ${invoiced.reason}`);
        }
        target = invoiced.entry;
      } else if (target.status === "invoiced" || target.status === "paid") {
        [target] = await tx
          .update(feeEntries)
          .set({
            dateInvoiced: args.invoiceDate,
            pennylaneInvoiceRef: target.pennylaneInvoiceRef ?? invoiceNumber,
            pennylaneInvoiceNumber: target.pennylaneInvoiceNumber ?? invoiceNumber,
          })
          .where(eq(feeEntries.id, target.id))
          .returning();
      } else {
        return {
          ok: false,
          status: 409,
          code: "FEE_ENTRY_NOT_INVOICEABLE",
          message: `L'écriture liée ne peut pas être facturée depuis l'état « ${target.status} ».`,
        };
      }

      let evidence: ArchitectFeeInvoice;
      const evidencePatch = {
        projectId: contract.projectId,
        milestoneId: milestone.id,
        feeEntryId: target.id,
        invoiceNumber,
        invoiceNumberNormalized: refNorm,
        issueDate: args.invoiceDate,
        amountHt: amountHt.toFixed(2),
        tvaAmount: roundCurrency(amountTtc - amountHt).toFixed(2),
        amountTtc: amountTtc.toFixed(2),
        source: "manual",
        status: "confirmed",
        reviewedBy: args.actor,
        reviewedAt: new Date(),
        notes: mergeNotes(existingEvidence?.notes ?? null, args.notes),
      } as const;

      if (existingEvidence) {
        [evidence] = await tx
          .update(architectFeeInvoices)
          .set(evidencePatch)
          .where(eq(architectFeeInvoices.id, existingEvidence.id))
          .returning();
      } else {
        [evidence] = await tx
          .insert(architectFeeInvoices)
          .values(evidencePatch)
          .returning();
      }

      const auditNote =
        args.mode === "record_invoice"
          ? `Facture ${invoiceNumber} enregistrée manuellement le ${args.invoiceDate}.`
          : `Détails historiques complétés pour la facture ${invoiceNumber} (facturée le ${args.invoiceDate}, payée le ${args.paymentDate}).`;
      await tx.insert(architectFeeInvoiceEvents).values({
        architectFeeInvoiceId: evidence.id,
        action: "confirmed",
        actor: args.actor,
        note: auditNote,
        details: {
          source: "manual",
          mode: args.mode,
          projectId: contract.projectId,
          milestoneId: milestone.id,
          feeEntryId: target.id,
          invoiceNumber,
          invoiceDate: args.invoiceDate,
          paymentDate: args.paymentDate ?? null,
          reconciliation,
        },
      });

      const milestonePatch: Record<string, unknown> = {
        invoicedAt: new Date(`${args.invoiceDate}T00:00:00Z`),
        notes: mergeNotes(milestone.notes, args.notes),
      };
      if (args.mode === "record_invoice") {
        milestonePatch.status = "invoiced";
      } else {
        milestonePatch.paidAt = new Date(`${args.paymentDate}T00:00:00Z`);
        await tx.insert(architectFeeInvoiceEvents).values({
          architectFeeInvoiceId: evidence.id,
          action: "milestone_paid",
          actor: args.actor,
          note: `Date de paiement historique enregistrée : ${args.paymentDate}.`,
          details: {
            source: "manual_details",
            milestoneId: milestone.id,
            paymentDate: args.paymentDate,
          },
        });
        await dismissOpenSuggestions(tx, milestone.id, args.actor);
      }

      const updated = await tx
        .update(designContractMilestones)
        .set(milestonePatch)
        .where(
          and(
            eq(designContractMilestones.id, milestone.id),
            eq(designContractMilestones.status, milestone.status),
          ),
        )
        .returning();
      if (updated.length !== 1) {
        throw new Error(`milestone ${milestone.id} manual invoice update affected ${updated.length} rows`);
      }

      return { ok: true, milestone: updated[0], evidence, feeEntryId: target.id, reconciliation };
    });
  } catch (error) {
    if (isNormalizedRefUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        code: "DUPLICATE_INVOICE_NUMBER",
        message: `La facture ${invoiceNumber} est déjà enregistrée sur un autre jalon ou projet.`,
      };
    }
    throw error;
  }
}

function resolveHtFactor(contract: typeof designContracts.$inferSelect): number | null {
  const totalTtc = Number(contract.totalTtc);
  if (!Number.isFinite(totalTtc) || totalTtc <= 0) return null;
  if (contract.totalHt != null && Number(contract.totalHt) >= 0) {
    return Number(contract.totalHt) / totalTtc;
  }
  if (contract.totalTva != null && Number(contract.totalTva) >= 0) {
    return (totalTtc - Number(contract.totalTva)) / totalTtc;
  }
  if (contract.tvaRate != null && Number(contract.tvaRate) >= 0) {
    return 1 / (1 + Number(contract.tvaRate) / 100);
  }
  const componentHt =
    Number(contract.conceptionAmountHt ?? 0) + Number(contract.planningAmountHt ?? 0);
  return componentHt > 0 ? componentHt / totalTtc : null;
}

function mergeNotes(existing: string | null, incoming?: string | null): string | null {
  const next = incoming?.trim();
  if (!next) return existing;
  if (!existing?.trim()) return next;
  if (existing.trim() === next) return existing;
  return `${existing}\n${next}`;
}

function lockEntriesBearingRef(tx: Tx, refNorm: string): Promise<FeeEntry[]> {
  const norm = (col: unknown): SQL =>
    sql`lower(regexp_replace(coalesce(${col}, ''), '[^a-zA-Z0-9]', '', 'g'))`;
  return tx
    .select()
    .from(feeEntries)
    .where(
      sql`(${norm(feeEntries.pennylaneInvoiceNumber)} = ${refNorm} OR ${norm(feeEntries.pennylaneInvoiceRef)} = ${refNorm})`,
    )
    .for("update");
}

async function dismissOpenSuggestions(tx: Tx, milestoneId: number, actor: string | null): Promise<void> {
  await tx
    .update(milestonePaymentSuggestions)
    .set({
      status: "dismissed",
      reviewedBy: actor ?? "auto:milestone-paid",
      reviewedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(milestonePaymentSuggestions.milestoneId, milestoneId),
        inArray(milestonePaymentSuggestions.status, ["pending_review", "ambiguous"]),
      ),
    );
}

function isNormalizedRefUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      record.code === "23505" &&
      (record.constraint === "architect_fee_invoices_ref_unique" ||
        record.constraint === "fee_entries_pennylane_invoice_unique")
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}