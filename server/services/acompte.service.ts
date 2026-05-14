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
    ? "facture d'acompte non encore reçue"
    : "facture d'acompte non encore payée";

  return {
    blocked: true,
    code: "acompte_unpaid",
    message: `Impossible de créer une situation/facture de progression : ${spec} doit être réglé avant facturation. État actuel : ${stateMsg}. Pour passer outre exceptionnellement, activez « Autoriser la facturation avant acompte » sur le devis.`,
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
  event: "link_invoice" | "mark_paid",
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
  }
}
