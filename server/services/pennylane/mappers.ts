/**
 * Pure mappers from local ArchiTrak shapes → Pennylane API payloads
 * (Task #214). Kept side-effect-free so unit tests can exercise them
 * without hitting the network.
 *
 * Two payloads:
 *   - mapProjectToCustomer:  POST /customers  (idempotent on external_id)
 *   - mapFeeEntryToCustomerInvoice: POST /customer_invoices
 *
 * External-id scheme (idempotency key that survives re-pushes):
 *   - customer:        `architrak:client:project:{projectId}`
 *   - customer_invoice: `architrak:fee_entry:{feeEntryId}`
 *
 * All EUR amounts round through roundCurrency() so we never ship
 * floating-point dust to Pennylane (their API rejects > 2dp).
 */

import { roundCurrency } from "@shared/financial-utils";
import type { FeeEntry, Project } from "@shared/schema";

export const TVA_RATE_PERCENT = 20;
export const TVA_RATE_DECIMAL = TVA_RATE_PERCENT / 100;

export const CUSTOMER_EXTERNAL_ID_PREFIX = "architrak:client:project:";
export const INVOICE_EXTERNAL_ID_PREFIX = "architrak:fee_entry:";

export function buildCustomerExternalId(projectId: number): string {
  return `${CUSTOMER_EXTERNAL_ID_PREFIX}${projectId}`;
}

export function buildInvoiceExternalId(feeEntryId: number): string {
  return `${INVOICE_EXTERNAL_ID_PREFIX}${feeEntryId}`;
}

export interface PennylaneCustomerPayload {
  external_id: string;
  // Pennylane allows individual vs company. Architect-firm clients
  // are individuals (private commissions) far more often than not,
  // so we default to individual but split a "M. et Mme" / company-
  // shaped name into first/last best-effort. The customer card can
  // be hand-edited in Pennylane afterwards.
  customer_type: "individual" | "company";
  name: string;
  first_name?: string;
  last_name?: string;
  emails?: string[];
  billing_address?: {
    address: string;
    city?: string;
    postal_code?: string;
    country_alpha2: string;
  };
}

/**
 * Split a French client display name into first / last for the
 * Pennylane individual schema. Returns `null` for the first name when
 * the name doesn't split cleanly (single word, "M. et Mme X", etc.)
 * — Pennylane is happy to accept `name` only, and a hand-edit on
 * their end is the right escape hatch for edge cases.
 */
export function splitClientName(name: string): { firstName: string | null; lastName: string } {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: null, lastName: "" };
  // Strip honorifics that confuse a naive split.
  const stripped = trimmed.replace(
    /^(?:M\.?(?:\s+et\s+Mme)?|Mme|Mlle|Mr\.?|Mrs\.?|Dr\.?)\s+/i,
    "",
  );
  const parts = stripped.split(/\s+/);
  if (parts.length <= 1) return { firstName: null, lastName: stripped || trimmed };
  // Treat the last whitespace-separated token as the surname and the
  // remainder as the given names. This is the French convention
  // ("Jean-Pierre Dupont" → first "Jean-Pierre", last "Dupont").
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(" ");
  return { firstName, lastName };
}

export function mapProjectToCustomer(project: Project): PennylaneCustomerPayload {
  const { firstName, lastName } = splitClientName(project.clientName);
  const payload: PennylaneCustomerPayload = {
    external_id: buildCustomerExternalId(project.id),
    customer_type: "individual",
    name: project.clientName,
    last_name: lastName,
  };
  if (firstName) payload.first_name = firstName;
  if (project.clientContactEmail) payload.emails = [project.clientContactEmail];
  if (project.clientAddress) {
    payload.billing_address = {
      address: project.clientAddress,
      country_alpha2: "FR",
    };
  }
  return payload;
}

export interface PennylaneCustomerInvoiceLine {
  label: string;
  quantity: number;
  // Unit price excluding VAT (HT), to 2dp.
  unit_amount: number;
  // Pennylane wants the rate as a decimal (0.2 for 20%).
  vat_rate: number;
  currency: "EUR";
}

export interface PennylaneCustomerInvoicePayload {
  external_id: string;
  customer_id: string;
  invoice_number_prefix?: string;
  date: string;     // ISO yyyy-mm-dd
  deadline: string; // ISO yyyy-mm-dd
  currency: "EUR";
  // Optional human-facing reference & description.
  reference?: string;
  description?: string;
  // The single honoraires line. ARCHITECT-SIDE ONLY (no contractor
  // detail leaks here).
  line_items: PennylaneCustomerInvoiceLine[];
}

export interface FeeEntryInvoiceContext {
  /** Resolved Pennylane customer id (NOT the local project id). */
  pennylaneCustomerId: string;
  /** Architect-facing label, e.g. "Honoraires d'architecte — Villa Exemple". */
  label: string;
  /** Optional human-readable reference (project code / fee entry id). */
  reference?: string;
  /** Optional long description (devis code, period, ...). */
  description?: string;
  /** Invoice issue date. Defaults to today. */
  issueDate?: Date;
  /** Payment terms in days from issue date (defaults to 30). */
  paymentTermsDays?: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the customer_invoice payload for a single fee entry.
 *
 * The HT amount comes straight from `feeEntry.feeAmount` — that
 * column is the single source of truth for architect commission and
 * is already rounded to 2dp by the upstream invariants (#fee-calc).
 * We re-round defensively in case of test fixtures.
 */
export function mapFeeEntryToCustomerInvoice(
  feeEntry: Pick<FeeEntry, "id" | "feeAmount">,
  ctx: FeeEntryInvoiceContext,
): PennylaneCustomerInvoicePayload {
  const unitAmount = roundCurrency(Number(feeEntry.feeAmount));
  const issue = ctx.issueDate ?? new Date();
  const deadline = new Date(issue);
  deadline.setDate(deadline.getDate() + (ctx.paymentTermsDays ?? 30));

  const payload: PennylaneCustomerInvoicePayload = {
    external_id: buildInvoiceExternalId(feeEntry.id),
    customer_id: ctx.pennylaneCustomerId,
    date: isoDate(issue),
    deadline: isoDate(deadline),
    currency: "EUR",
    line_items: [
      {
        label: ctx.label,
        quantity: 1,
        unit_amount: unitAmount,
        vat_rate: TVA_RATE_DECIMAL,
        currency: "EUR",
      },
    ],
  };
  if (ctx.reference) payload.reference = ctx.reference;
  if (ctx.description) payload.description = ctx.description;
  return payload;
}
