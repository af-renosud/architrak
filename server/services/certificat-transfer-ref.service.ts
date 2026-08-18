/**
 * Task #627 — Bank-transfer reference derivation for certificat PDFs.
 *
 * Gives the client a single string to paste into their bank's "payment
 * reference" field, and gives the contractor a key they can match against
 * their own invoice number(s).
 *
 * Format: `{PROJECT CODE} {certificat ref} / {invoice numbers joined with " + "}`
 *
 * Fallbacks (in priority order):
 *   1. Scoped progress certificat: supplier invoice numbers (e.g. "F-2026-138").
 *   2. Acompte certificat (no supplier invoice): devis code.
 *   3. Legacy certificat (no certificat_sources rows): devis codes from the
 *      contractor's whole-project devis list.
 *   4. Nothing at all: bare `{PROJECT CODE} {certificat ref}`.
 *
 * The result is truncated to TRANSFER_REF_MAX_LEN (100) so bank systems do
 * not chop it silently.
 */

export const TRANSFER_REF_MAX_LEN = 100;

export interface TransferRefInputs {
  /** project.code if set, otherwise falls back to a prefix of project.name */
  projectCode: string | null;
  projectName: string;
  certificateRef: string;
  /**
   * Contractor invoice numbers for the certified factures — empty for
   * acompte certificats and legacy certificats without source rows.
   */
  invoiceNumbers: string[];
  /**
   * Devis codes used as a fallback when invoiceNumbers is empty (acompte
   * or legacy).
   */
  devisCodes: string[];
}

/**
 * Pure, synchronous reference derivation — no DB access, easy to unit-test.
 * All DB-dependent resolution is done by the caller before passing inputs here.
 */
export function deriveTransferRef(inputs: TransferRefInputs): string {
  // Project identifier: use the FULL project code when one is set — bank
  // references must remain recognisable, so we never truncate the code.
  // When falling back to the project name (no code), cap at 15 chars to
  // keep the reference readable.
  const projectId = inputs.projectCode != null
    ? inputs.projectCode.trim().toUpperCase().replace(/\s+/g, "-")
    : inputs.projectName.slice(0, 15).trim().toUpperCase().replace(/\s+/g, "-");

  const base = `${projectId} ${inputs.certificateRef}`;

  // Enforce the ceiling even on the bare base (pathological but possible if
  // a project code + cert ref is very long).
  if (base.length >= TRANSFER_REF_MAX_LEN) {
    return `${base.slice(0, TRANSFER_REF_MAX_LEN - 1)}…`;
  }

  // Prefer invoice numbers; fall through to devis codes.
  const parts =
    inputs.invoiceNumbers.length > 0
      ? inputs.invoiceNumbers
      : inputs.devisCodes;

  if (parts.length === 0) return base;

  const sep = " / ";
  const suffix = parts.join(" + ");
  const full = `${base}${sep}${suffix}`;
  if (full.length <= TRANSFER_REF_MAX_LEN) return full;

  // Truncate suffix to fit the budget; always leave room for the ellipsis.
  // If the budget is zero or negative (base + sep alone fills the cap)
  // drop the suffix entirely and return just the base.
  const budget = TRANSFER_REF_MAX_LEN - base.length - sep.length - 1;
  if (budget <= 0) return base;
  return `${base}${sep}${suffix.slice(0, budget)}…`;
}
