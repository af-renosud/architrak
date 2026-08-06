/**
 * System-wide dedup for intake documents (third dedup layer).
 *
 * The first two intake dedup layers compare file bytes and extracted-content
 * hashes against OTHER INTAKE DOCUMENTS. They cannot catch a document whose
 * typed devis/invoice record predates the intake system (or arrived via a
 * different upload path). This module compares the AI-extracted business
 * identity (document number, contractor, HT amount) of an incoming document
 * against ALL existing typed devis and invoice records in the project.
 *
 * Pure comparison logic ONLY — no I/O, no storage access — so it is testable
 * from shared/__tests__. The intake pipeline supplies the project's records.
 *
 * Verdicts:
 *  - "duplicate": document number AND HT amount both match an existing record
 *    → safe to auto-flag; no draft is created.
 *  - "review": strong partial match (same number / different amount, or same
 *    contractor + same amount without a number match) → parked for a human.
 *    The pipeline never guesses on money.
 *  - "none": no meaningful match → routing continues unchanged.
 */
import { roundCurrency } from "./financial-utils";

/** Minimal shape of an existing devis row needed for dedup. */
export interface DedupDevisRecord {
  id: number;
  contractorId: number;
  devisNumber: string | null;
  devisCode: string;
  /** numeric column arrives as a string from drizzle */
  amountHt: string | number;
}

/** Minimal shape of an existing invoice row needed for dedup. */
export interface DedupInvoiceRecord {
  id: number;
  contractorId: number;
  invoiceNumber: string | null;
  amountHt: string | number;
}

/** Minimal shape of the parsed extraction needed for dedup. */
export interface DedupExtraction {
  documentType: string;
  devisNumber?: string | null;
  invoiceNumber?: string | null;
  reference?: string | null;
  contractorName?: string | null;
  amountHt?: number | null;
}

export type DedupVerdict =
  | {
      verdict: "duplicate" | "review";
      matchKind: "devis" | "invoice";
      matchId: number;
      /** Human-readable reason naming the matched record. */
      reason: string;
    }
  | { verdict: "none" };

/**
 * Normalize a document reference (devis/invoice number) for comparison:
 * lowercase, accent-stripped, all non-alphanumerics removed.
 * "DEV-2024/042" ≡ "dev 2024 042" ≡ "Dev2024·042".
 */
export function normalizeRef(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Normalize a company name: like normalizeRef, but also strips common French
 * legal-form tokens so "SARL Dupont Bâtiment" ≡ "DUPONT BATIMENT sas".
 */
export function normalizeCompanyName(value: string | null | undefined): string {
  if (!value) return "";
  const cleaned = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const LEGAL_FORMS = new Set(["sarl", "sas", "sasu", "sa", "eurl", "sci", "snc", "ei", "eirl", "ste", "societe", "ets", "entreprise"]);
  return cleaned
    .split(" ")
    .filter((tok) => tok && !LEGAL_FORMS.has(tok))
    .join("");
}

function amountsMatch(a: number | null | undefined, b: string | number | null | undefined): boolean {
  if (a == null || b == null) return false;
  const nb = typeof b === "string" ? parseFloat(b) : b;
  if (!isFinite(nb) || !isFinite(a)) return false;
  return roundCurrency(a) === roundCurrency(nb);
}

/** Candidate normalized refs extracted from the parsed document. */
function extractionRefs(parsed: DedupExtraction, kind: "devis" | "invoice"): string[] {
  const raw = kind === "devis" ? [parsed.devisNumber, parsed.reference] : [parsed.invoiceNumber, parsed.reference];
  const refs = raw.map(normalizeRef).filter((r) => r.length > 0);
  return Array.from(new Set(refs));
}

/**
 * Compare an incoming extraction against the project's existing typed
 * devis + invoice records. `contractorNames` maps contractor id → name so
 * fuzzy contractor+amount matches can be evaluated by name.
 */
export function evaluateIntakeDedup(
  parsed: DedupExtraction,
  existingDevis: DedupDevisRecord[],
  existingInvoices: DedupInvoiceRecord[],
  contractorNames: Record<number, string>,
): DedupVerdict {
  const isQuotation = parsed.documentType === "quotation";
  const isInvoiceLike = parsed.documentType === "invoice" || parsed.documentType === "acompte";
  if (!isQuotation && !isInvoiceLike) return { verdict: "none" };

  const kind = isQuotation ? "devis" : "invoice";
  const refs = extractionRefs(parsed, kind);
  const parsedName = normalizeCompanyName(parsed.contractorName);
  const amount = parsed.amountHt ?? null;

  type Candidate = {
    id: number;
    contractorId: number;
    amountHt: string | number;
    recordRefs: string[];
    label: string;
  };

  const candidates: Candidate[] = isQuotation
    ? existingDevis.map((d) => ({
        id: d.id,
        contractorId: d.contractorId,
        amountHt: d.amountHt,
        recordRefs: [normalizeRef(d.devisNumber), normalizeRef(d.devisCode)].filter((r) => r.length > 0),
        label: `devis ${d.devisNumber || d.devisCode} (#${d.id})`,
      }))
    : existingInvoices.map((inv) => ({
        id: inv.id,
        contractorId: inv.contractorId,
        amountHt: inv.amountHt,
        recordRefs: [normalizeRef(inv.invoiceNumber)].filter((r) => r.length > 0),
        label: `invoice ${inv.invoiceNumber || `#${inv.id}`} (#${inv.id})`,
      }));

  // Pass 1 — exact business-identity duplicate: number AND amount match.
  for (const c of candidates) {
    const refMatch = refs.length > 0 && c.recordRefs.some((r) => refs.includes(r));
    if (refMatch && amountsMatch(amount, c.amountHt)) {
      return {
        verdict: "duplicate",
        matchKind: kind,
        matchId: c.id,
        reason: `Duplicate of existing ${c.label}: same ${kind === "devis" ? "devis" : "invoice"} number and same HT amount (${roundCurrency(amount!)} €).`,
      };
    }
  }

  // Pass 2 — same number, different amount → probable revision; review.
  for (const c of candidates) {
    const refMatch = refs.length > 0 && c.recordRefs.some((r) => refs.includes(r));
    if (refMatch) {
      return {
        verdict: "review",
        matchKind: kind,
        matchId: c.id,
        reason: `Possible duplicate — review before routing: same number as existing ${c.label} but a different HT amount (incoming ${amount != null ? `${roundCurrency(amount)} €` : "unknown"} vs existing ${c.amountHt} €). Could be a revision.`,
      };
    }
  }

  // Pass 3 — same contractor (by normalized name) + same amount, no number
  // match → strong near-miss; review.
  if (parsedName && amount != null) {
    for (const c of candidates) {
      const recordName = normalizeCompanyName(contractorNames[c.contractorId]);
      if (recordName && recordName === parsedName && amountsMatch(amount, c.amountHt)) {
        return {
          verdict: "review",
          matchKind: kind,
          matchId: c.id,
          reason: `Possible duplicate — review before routing: same contractor (${contractorNames[c.contractorId]}) and same HT amount (${roundCurrency(amount)} €) as existing ${c.label}, but no matching document number.`,
        };
      }
    }
  }

  return { verdict: "none" };
}
