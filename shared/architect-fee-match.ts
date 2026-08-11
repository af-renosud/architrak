/**
 * Architect fee-invoice detection & matching (Task #425).
 *
 * The firm's OWN outbound honoraires invoices (e.g.
 * "Facture-Heinz Hermann TRÜTKEN-ARCHITECTS-FRANCE-F-2026-138.pdf") are
 * picked up by Gmail polling alongside contractor documents. They must
 * NEVER be routed down the contractor facture path — instead they are
 * typed `architect_fee_invoice` and parked in a dedicated review queue.
 *
 * Pure logic ONLY — no I/O — so it is testable from shared/__tests__.
 *
 * Two responsibilities:
 *  1. Firm-identity gate: deterministic issuer check that both CONFIRMS
 *     an AI `architect_fee_invoice` classification and RESCUES a firm
 *     invoice the AI typed as a plain contractor `invoice`. Sender or
 *     filename alone is never proof — the PDF issuer (SIRET or legal
 *     name extracted from the document body) must match the firm profile.
 *  2. Candidate ranking: project candidates from client/project name and
 *     address; milestone candidates from exact TTC match (tax-reconciled),
 *     label token overlap and sequence. Money is never auto-confirmed —
 *     ranking only produces suggestions for the human review queue.
 */
import { roundCurrency } from "./financial-utils";
import { normalizeRef, normalizeCompanyName } from "./intake-dedup";

/** Server-controlled firm identity profile (env-derived, never AI-derived). */
export interface FirmProfile {
  /** Normalized 14-digit SIRET, empty when not configured. */
  siret: string;
  /** Legal name(s) of the firm, e.g. ["SAS ARCHITECTS-FRANCE", "ARCHITECTS-FRANCE"]. */
  legalNames: string[];
}

/** Minimal extraction shape needed by the gate + ranking. */
export interface FeeInvoiceExtraction {
  documentType: string;
  /** On the firm's own invoice the "contractor" slot IS the firm (issuer). */
  contractorName?: string | null;
  clientName?: string | null;
  projectAddress?: string | null;
  invoiceNumber?: string | null;
  reference?: string | null;
  siret?: string | null;
  date?: string | null;
  amountHt?: number | null;
  amountTtc?: number | null;
  tvaAmount?: number | null;
  tvaRate?: number | null;
  description?: string | null;
}

export interface FirmIdentityVerdict {
  isFirm: boolean;
  /** Human-readable audit reason. */
  reason: string;
}

/**
 * Deterministic issuer check against the firm profile. SIRET match is
 * authoritative; legal-name match is accepted as fallback (French invoices
 * always carry the issuer name on the letterhead). Never matches on empty
 * profile data.
 */
export function matchesFirmIdentity(
  parsed: Pick<FeeInvoiceExtraction, "contractorName" | "siret">,
  profile: FirmProfile,
): FirmIdentityVerdict {
  const docSiret = (parsed.siret ?? "").replace(/\D/g, "");
  if (profile.siret && docSiret && docSiret === profile.siret) {
    return { isFirm: true, reason: `issuer SIRET ${docSiret} matches firm profile` };
  }
  // An explicit, well-formed, NON-matching SIRET on the document outranks
  // any letterhead-name resemblance: a different company that happens to
  // carry a similar name is NOT the firm. Checked BEFORE name matching.
  if (profile.siret && docSiret && docSiret.length === 14 && docSiret !== profile.siret) {
    return { isFirm: false, reason: `issuer SIRET ${docSiret} differs from firm SIRET` };
  }
  const issuerName = normalizeCompanyName(parsed.contractorName);
  if (issuerName) {
    for (const name of profile.legalNames) {
      const normProfile = normalizeCompanyName(name);
      if (normProfile && (issuerName === normProfile || issuerName.includes(normProfile) || normProfile.includes(issuerName))) {
        return { isFirm: true, reason: `issuer name "${parsed.contractorName}" matches firm legal name "${name}"` };
      }
    }
  }
  return { isFirm: false, reason: "no firm SIRET or legal-name match on document issuer" };
}

export interface FirmGateResult {
  /** Possibly rewritten documentType. */
  documentType: string;
  /** True when the gate changed or confirmed the type as architect_fee_invoice. */
  isArchitectFeeInvoice: boolean;
  /** Audit reason, always populated when a rewrite/confirmation happened. */
  gateReason?: string;
}

/**
 * Applies the firm-identity gate to an AI classification:
 *  - AI said `architect_fee_invoice` but issuer is NOT the firm → downgrade
 *    to `invoice` (the contractor path's own guards then apply). Prevents a
 *    hallucinated type from bypassing contractor routing.
 *  - AI said `invoice`/`acompte` but issuer IS the firm → upgrade to
 *    `architect_fee_invoice`. Prevents the firm's own revenue from being
 *    recorded as contractor spend.
 *  - Everything else passes through unchanged.
 */
export function applyFirmIdentityGate(
  parsed: FeeInvoiceExtraction,
  profile: FirmProfile,
): FirmGateResult {
  const identity = matchesFirmIdentity(parsed, profile);
  if (parsed.documentType === "architect_fee_invoice") {
    if (identity.isFirm) {
      return { documentType: "architect_fee_invoice", isArchitectFeeInvoice: true, gateReason: `confirmed: ${identity.reason}` };
    }
    return {
      documentType: "invoice",
      isArchitectFeeInvoice: false,
      gateReason: `AI typed architect_fee_invoice but ${identity.reason} — downgraded to invoice`,
    };
  }
  if ((parsed.documentType === "invoice" || parsed.documentType === "acompte") && identity.isFirm) {
    return {
      documentType: "architect_fee_invoice",
      isArchitectFeeInvoice: true,
      gateReason: `AI typed ${parsed.documentType} but issuer is the firm (${identity.reason}) — reclassified as architect_fee_invoice`,
    };
  }
  return { documentType: parsed.documentType, isArchitectFeeInvoice: false };
}

// ─── Candidate ranking ────────────────────────────────────────────────────

export interface ProjectCandidateInput {
  id: number;
  name: string;
  clientName: string;
  siteAddress?: string | null;
  clientAddress?: string | null;
}

export interface RankedProjectCandidate {
  projectId: number;
  score: number;
  reasons: string[];
}

function tokenSet(value: string | null | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 3),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  a.forEach((t) => {
    if (b.has(t)) hits++;
  });
  return hits / Math.min(a.size, b.size);
}

/**
 * Rank projects for a firm fee invoice. Signals (additive):
 *  - exact normalized client-name match: +60
 *  - client-name token overlap ≥0.5: +30
 *  - project-name token overlap with client name / invoice haystack: +20
 *  - address token overlap ≥0.5: +15
 * Result sorted descending; only scores > 0 returned.
 */
export function rankProjectCandidates(
  parsed: FeeInvoiceExtraction,
  projects: ProjectCandidateInput[],
  extraHaystack?: string | null,
): RankedProjectCandidate[] {
  const parsedClient = normalizeCompanyName(parsed.clientName);
  const parsedClientTokens = tokenSet(parsed.clientName);
  const haystackTokens = tokenSet(`${parsed.description ?? ""} ${parsed.reference ?? ""} ${extraHaystack ?? ""}`);
  const parsedAddrTokens = tokenSet(parsed.projectAddress);

  const out: RankedProjectCandidate[] = [];
  for (const p of projects) {
    let score = 0;
    const reasons: string[] = [];
    const projClient = normalizeCompanyName(p.clientName);
    if (parsedClient && projClient && parsedClient === projClient) {
      score += 60;
      reasons.push(`client name exact match ("${p.clientName}")`);
    } else {
      const overlap = tokenOverlap(parsedClientTokens, tokenSet(p.clientName));
      if (overlap >= 0.5) {
        score += 30;
        reasons.push(`client name partial match ("${p.clientName}")`);
      }
    }
    const nameTokens = tokenSet(p.name);
    const nameOverlap = Math.max(tokenOverlap(nameTokens, parsedClientTokens), tokenOverlap(nameTokens, haystackTokens));
    if (nameOverlap >= 0.5) {
      score += 20;
      reasons.push(`project name match ("${p.name}")`);
    }
    const addrOverlap = Math.max(
      tokenOverlap(parsedAddrTokens, tokenSet(p.siteAddress)),
      tokenOverlap(parsedAddrTokens, tokenSet(p.clientAddress)),
    );
    if (addrOverlap >= 0.5) {
      score += 15;
      reasons.push("address match");
    }
    if (score > 0) out.push({ projectId: p.id, score, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * A project match is "high confidence" when the top candidate scores ≥60
 * AND leads the runner-up by ≥30 points. Anything weaker requires the
 * operator to choose (ambiguity is surfaced, never guessed away).
 */
export function isHighConfidenceProjectMatch(ranked: RankedProjectCandidate[]): boolean {
  if (ranked.length === 0) return false;
  if (ranked[0].score < 60) return false;
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < 30) return false;
  return true;
}

export interface MilestoneCandidateInput {
  id: number;
  sequence: number;
  labelFr: string;
  labelEn?: string | null;
  amountTtc: string | number;
  status: string;
}

export interface RankedMilestoneCandidate {
  milestoneId: number;
  score: number;
  reasons: string[];
}

function toNumber(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Invoice total TTC reconciled from whatever amounts the extraction carries:
 * prefer amountTtc; else derive from HT + TVA amount; else HT × (1 + rate).
 */
export function reconciledInvoiceTtc(parsed: FeeInvoiceExtraction): number | null {
  if (parsed.amountTtc != null && Number.isFinite(parsed.amountTtc)) return roundCurrency(parsed.amountTtc);
  if (parsed.amountHt != null && Number.isFinite(parsed.amountHt)) {
    if (parsed.tvaAmount != null && Number.isFinite(parsed.tvaAmount)) {
      return roundCurrency(parsed.amountHt + parsed.tvaAmount);
    }
    if (parsed.tvaRate != null && Number.isFinite(parsed.tvaRate)) {
      return roundCurrency(parsed.amountHt * (1 + parsed.tvaRate / 100));
    }
  }
  return null;
}

/**
 * Rank a contract's milestones against the invoice. Non-paid milestones
 * only. Signals (additive):
 *  - exact TTC match (to the cent, after tax reconciliation): +60
 *  - label token overlap with invoice description ≥0.5: +25
 *  - earliest non-paid, non-invoiced milestone in sequence order: +10
 */
export function rankMilestoneCandidates(
  parsed: FeeInvoiceExtraction,
  milestones: MilestoneCandidateInput[],
): RankedMilestoneCandidate[] {
  const invoiceTtc = reconciledInvoiceTtc(parsed);
  const descTokens = tokenSet(`${parsed.description ?? ""} ${parsed.reference ?? ""}`);
  const open = milestones.filter((m) => m.status !== "paid");
  const firstOpen = [...open]
    .filter((m) => m.status === "pending" || m.status === "reached")
    .sort((a, b) => a.sequence - b.sequence)[0];

  const out: RankedMilestoneCandidate[] = [];
  for (const m of open) {
    let score = 0;
    const reasons: string[] = [];
    const mAmount = toNumber(m.amountTtc);
    if (invoiceTtc != null && mAmount != null && roundCurrency(mAmount) === invoiceTtc) {
      score += 60;
      reasons.push(`exact TTC match (${invoiceTtc.toFixed(2)} €)`);
    }
    const labelOverlap = Math.max(tokenOverlap(tokenSet(m.labelFr), descTokens), tokenOverlap(tokenSet(m.labelEn), descTokens));
    if (labelOverlap >= 0.5) {
      score += 25;
      reasons.push(`label match ("${m.labelFr}")`);
    }
    if (firstOpen && m.id === firstOpen.id) {
      score += 10;
      reasons.push("next open milestone in sequence");
    }
    if (score > 0) out.push({ milestoneId: m.id, score, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Business-ref normalization for dedup — same rules as intake refs. */
export function normalizeInvoiceRef(value: string | null | undefined): string {
  return normalizeRef(value);
}
