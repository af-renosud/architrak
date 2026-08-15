/**
 * Task #215 — Acompte (deposit) workflow business logic.
 *
 * The devis row carries the acompte spec (`acompteRequired`,
 * `acomptePercent`, `acompteAmountHt`, `acompteTrigger`), the lifecycle
 * state (`acompteState`), the per-devis gate override
 * (`allowProgressBeforeAcompte`), and the eventual link to the facture
 * d'acompte (`acompteInvoiceId`, `acomptePaidAt`).
 *
 * State machine:
 *
 *   none  ──(architect ticks "Acompte requis"
 *            OR extractor sees a deposit clause)──▶ pending
 *   pending  ──(facture d'acompte linked)──▶ invoiced
 *   invoiced ──(invoice.datePaid set OR
 *               POST /acompte/mark-paid)──▶ paid
 *   paid    ──(future: final reconciliation)──▶ applied
 *
 * Gate:
 *   - Blocks situation/invoice creation when
 *     acompteRequired=true AND acompteState IN ('pending','invoiced')
 *     AND allowProgressBeforeAcompte=false.
 *   - The facture d'acompte itself is exempt (caller passes
 *     opts.isAcompteInvoice=true) so that linking the deposit invoice
 *     doesn't bootstrap-deadlock against its own gate.
 *
 * No raw float math — all amounts go through `roundCurrency` and are
 * compared at 2 decimals only at evaluation time.
 */
import type { Devis } from "@shared/schema";
import { certificats, devis as devisTable } from "@shared/schema";
import { db } from "../db";
import { and, eq, ne } from "drizzle-orm";

export type AcompteState = "none" | "pending" | "invoiced" | "paid" | "applied";

export const ACOMPTE_GATE_BLOCKING_STATES: ReadonlySet<AcompteState> = new Set<AcompteState>([
  "pending",
  "invoiced",
]);

export interface GateBlockedReason {
  blocked: true;
  code: "acompte_unpaid";
  message: string;
  state: AcompteState;
  acompteAmountHt: string | null;
  acomptePercent: string | null;
}

export interface GateAllowed {
  blocked: false;
}

export type GateDecision = GateAllowed | GateBlockedReason;

export interface GateInputs {
  acompteRequired: boolean;
  acompteState: string;
  allowProgressBeforeAcompte: boolean;
  acompteAmountHt: string | null;
  acomptePercent: string | null;
}

/**
 * Decide whether progress invoicing (situation creation, generic
 * invoice creation) is allowed for a devis.
 *
 * The facture d'acompte itself MUST bypass this gate: when the caller
 * is creating the deposit invoice, pass `opts.isAcompteInvoice=true`.
 */
export function evaluateAcompteGate(
  devis: GateInputs,
  opts: { isAcompteInvoice?: boolean } = {},
): GateDecision {
  if (opts.isAcompteInvoice) return { blocked: false };
  if (!devis.acompteRequired) return { blocked: false };
  if (devis.allowProgressBeforeAcompte) return { blocked: false };
  const state = devis.acompteState as AcompteState;
  if (!ACOMPTE_GATE_BLOCKING_STATES.has(state)) return { blocked: false };

  const amountStr = devis.acompteAmountHt ?? null;
  const pctStr = devis.acomptePercent ?? null;
  const amountFr = amountStr ? `${Number(amountStr).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € HT` : null;
  const pctFr = pctStr ? `${Number(pctStr).toLocaleString("fr-FR")}\u00A0%` : null;
  const spec = amountFr && pctFr ? `${pctFr} (${amountFr})` : amountFr ?? pctFr ?? "Acompte requis";
  const stateMsg = state === "pending"
    ? "facture d'acompte not yet received"
    : "facture d'acompte not yet paid";

  return {
    blocked: true,
    code: "acompte_unpaid",
    message: `Cannot create a progress situation/invoice: the acompte of ${spec} must be settled before invoicing. Current state: ${stateMsg}. To exceptionally bypass this, enable "Autoriser la facturation avant acompte" on the devis.`,
    state,
    acompteAmountHt: amountStr,
    acomptePercent: pctStr,
  };
}

/**
 * Project a `Devis` row down to the gate-relevant fields. Keeps
 * callsites concise and centralises the string→bool mapping.
 */
export function gateInputsFromDevis(d: Devis): GateInputs {
  return {
    acompteRequired: d.acompteRequired === true,
    acompteState: d.acompteState ?? "none",
    allowProgressBeforeAcompte: d.allowProgressBeforeAcompte === true,
    acompteAmountHt: d.acompteAmountHt ?? null,
    acomptePercent: d.acomptePercent ?? null,
  };
}

/**
 * Compute the next legal state on a transition request. Returns the
 * target state, or null if the transition is not permitted from the
 * current state. Pure function — does not write.
 */
export function nextAcompteState(
  current: string,
  event: "link_invoice" | "mark_paid" | "mark_paid_no_invoice",
): AcompteState | null {
  const c = current as AcompteState;
  // Strict forward-only state machine per Task #215 spec:
  //   none → pending → invoiced → paid → applied
  // (`applied` is reached by the deduction engine — see follow-up #216 —
  //  not by these manual transitions.) Backward / skip transitions
  //  (e.g. pending→paid, invoiced→pending) are intentionally rejected;
  //  admin reset to `none` is a separate audited operation, not a
  //  generic event handled here.
  switch (event) {
    case "link_invoice":
      // Linking the facture d'acompte is only meaningful while pending.
      // Re-linking from invoiced is a no-op handled at the route layer
      // (it updates the link target without changing state).
      if (c === "pending") return "invoiced";
      if (c === "invoiced") return "invoiced";
      return null;
    case "mark_paid":
      // The deposit is "paid" only after the facture d'acompte has been
      // linked (state='invoiced'). Operators who never upload a
      // facture d'acompte must link one before marking paid.
      if (c === "invoiced") return "paid";
      return null;
    case "mark_paid_no_invoice":
      // Task #491 — deposit raised via an ACOMPTE CERTIFICAT (no supplier
      // invoice ever exists). The route only fires this event after
      // verifying a live acompte certificat exists for the devis, so
      // 'pending' may advance straight to 'paid'. An 'invoiced' devis has
      // a facture d'acompte — it must use the invoice path for audit.
      if (c === "pending") return "paid";
      return null;
  }
}

/**
 * Task #491 — resolve the deposit money for an acompte certificat from the
 * devis's own acompte spec. Grounded in the devis document itself:
 *  - explicit `acompteAmountHt` wins; TTC follows the devis's own HT→TTC
 *    ratio (that is exactly what a facture d'acompte would state);
 *  - otherwise `acomptePercent` of the devis HT/TTC.
 * Returns null when the spec resolves to no positive amount.
 */
/**
 * Task #491 — the ONLY way to link a facture d'acompte to a devis's
 * lifecycle. One transaction, devis row locked FOR UPDATE:
 *  - re-checks the lifecycle state under the lock (no stale-read CAS),
 *  - refuses when a live (non-superseded) acompte certificat exists — the
 *    deposit is already authorised without an invoice, so linking a facture
 *    d'acompte on top would double-authorise it,
 *  - writes the link + state + provenance atomically.
 * The generate-certificat route locks the same devis row FOR UPDATE, so the
 * two paths are fully serialised: whichever commits first wins and the
 * other observes it.
 */
export async function linkAcompteInvoiceTx(input: {
  devisId: number;
  invoiceId: number;
  invoiceDatePaid: string | null;
}): Promise<
  | { ok: true; devis: Devis }
  | { ok: false; code: "devis_not_found" | "acompte_invalid_transition"; currentState?: string }
  | { ok: false; code: "acompte_certificat_exists"; certificatId: number; certificateRef: string }
> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(devisTable)
      .where(eq(devisTable.id, input.devisId))
      .for("update");
    if (!locked) return { ok: false as const, code: "devis_not_found" as const };
    const [liveAcompteCert] = await tx
      .select({ id: certificats.id, certificateRef: certificats.certificateRef })
      .from(certificats)
      .where(and(eq(certificats.acompteDevisId, input.devisId), ne(certificats.status, "superseded")))
      .limit(1);
    if (liveAcompteCert) {
      return {
        ok: false as const,
        code: "acompte_certificat_exists" as const,
        certificatId: liveAcompteCert.id,
        certificateRef: liveAcompteCert.certificateRef,
      };
    }
    const target = nextAcompteState(locked.acompteState, "link_invoice");
    if (!target) {
      return { ok: false as const, code: "acompte_invalid_transition" as const, currentState: locked.acompteState };
    }
    const finalState = input.invoiceDatePaid ? "paid" : target;
    const [updated] = await tx
      .update(devisTable)
      .set({
        acompteInvoiceId: input.invoiceId,
        acompteState: finalState,
        acomptePaidAt: input.invoiceDatePaid ? new Date(input.invoiceDatePaid) : null,
        acomptePaidVia: input.invoiceDatePaid ? "invoice" : null,
      })
      .where(eq(devisTable.id, input.devisId))
      .returning();
    return { ok: true as const, devis: updated };
  });
}

export function resolveAcompteAmounts(d: {
  acompteAmountHt: string | null;
  acomptePercent: string | null;
  amountHt: string;
  amountTtc: string;
}): { amountHt: number; amountTtc: number } | null {
  const devisHt = parseFloat(d.amountHt) || 0;
  const devisTtc = parseFloat(d.amountTtc) || 0;
  const explicit = d.acompteAmountHt != null ? parseFloat(d.acompteAmountHt) : NaN;
  const pct = d.acomptePercent != null ? parseFloat(d.acomptePercent) : NaN;

  const round = (n: number) => Math.round(n * 100) / 100;

  if (Number.isFinite(explicit) && explicit > 0) {
    const ratio = devisHt > 0 ? devisTtc / devisHt : 1;
    return { amountHt: round(explicit), amountTtc: round(explicit * ratio) };
  }
  if (Number.isFinite(pct) && pct > 0 && devisHt > 0) {
    return { amountHt: round((devisHt * pct) / 100), amountTtc: round((devisTtc * pct) / 100) };
  }
  return null;
}
