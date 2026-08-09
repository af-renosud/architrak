/**
 * Task #346 — pure eligibility rules for "reopen for review".
 *
 * Confirming an AI-extracted draft moves it draft → pending; reopening is
 * the explicit reverse transition (pending → draft) so an architect can
 * review a draft more than once. These rules decide when that reverse
 * transition is safe. They are pure (no DB access) so they can be
 * unit-tested; the transactional wrapper lives in
 * draft-reopen.service.ts.
 *
 * A devis may be reopened only while nothing downstream depends on its
 * confirmed values:
 *   - status must be exactly "pending" (draft = nothing to reopen;
 *     void/anything else = wrong lifecycle);
 *   - the sign-off workflow must not have started (signOffStage still
 *     "received" — any later stage means internal checks / client
 *     signing built on the confirmed figures);
 *   - no invoices and no situations may reference it (money has moved).
 *
 * An invoice may be reopened only while status is exactly "pending" —
 * approval triggers the fee calculation, which must never be silently
 * unwound.
 */

export type ReopenVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export interface DevisReopenInput {
  status: string;
  signOffStage: string;
  invoiceCount: number;
  situationCount: number;
}

export function evaluateDevisReopen(input: DevisReopenInput): ReopenVerdict {
  if (input.status === "draft") {
    return { ok: false, reason: "This devis is already a draft — open the review panel directly." };
  }
  if (input.status !== "pending") {
    return { ok: false, reason: `Only pending devis can be reopened for review (current status: ${input.status}).` };
  }
  if (input.signOffStage !== "received") {
    return {
      ok: false,
      reason: "The sign-off workflow has already started for this devis — reopening would invalidate checks built on the confirmed values.",
    };
  }
  if (input.invoiceCount > 0) {
    return {
      ok: false,
      reason: "Invoices already reference this devis — its confirmed amounts can no longer be reopened for editing.",
    };
  }
  if (input.situationCount > 0) {
    return {
      ok: false,
      reason: "Situations already reference this devis — its confirmed amounts can no longer be reopened for editing.",
    };
  }
  return { ok: true };
}

export interface InvoiceReopenInput {
  status: string;
}

export function evaluateInvoiceReopen(input: InvoiceReopenInput): ReopenVerdict {
  if (input.status === "draft") {
    return { ok: false, reason: "This invoice is already a draft — open the review panel directly." };
  }
  if (input.status === "approved") {
    return {
      ok: false,
      reason: "This invoice is approved and its commission has been calculated — it can no longer be reopened for review.",
    };
  }
  if (input.status !== "pending") {
    return { ok: false, reason: `Only pending invoices can be reopened for review (current status: ${input.status}).` };
  }
  return { ok: true };
}
