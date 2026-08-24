export function roundCurrency(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;
}

export function deriveTvaAmount(amountHt: number, amountTtc: number): number {
  return roundCurrency(amountTtc - amountHt);
}

export function calculateAdjustedAmount(originalHt: number, pvTotal: number, mvTotal: number): number {
  return roundCurrency(originalHt + pvTotal - mvTotal);
}

export function calculateResteARealiser(adjustedHt: number, certifiedHt: number): number {
  return roundCurrency(adjustedHt - certifiedHt);
}

export function calculateFeeAmount(invoiceHt: number, feeRate: number): number {
  return roundCurrency(invoiceHt * feeRate / 100);
}

const DEFAULT_TVA_RATE = 0.2;

/**
 * Task #479 — documentary effective TVA rate (%) from source-document
 * HT/TTC sums. French contractor invoices routinely mix rates (10% rénovation
 * + 20% supplies, sometimes 5.5%), so no single statutory rate reproduces the
 * invoice's real tax; the blended effective rate (ΣTTC − ΣHT) / ΣHT does.
 * Returns null when there is no usable evidence: zero/negative HT base,
 * TTC below HT, or a rate outside the sane French bracket [0, 30] (a wild
 * rate means bad extraction data, and money must not follow bad data).
 * Rounded to 2 decimals so the same figure is persisted, displayed and
 * re-derivable. Shared: the client mirrors the server preview with it.
 */
export function computeEffectiveTvaRatePercent(sumHt: number, sumTtc: number): number | null {
  if (!Number.isFinite(sumHt) || !Number.isFinite(sumTtc)) return null;
  if (sumHt <= 0 || sumTtc < sumHt) return null;
  const rate = ((sumTtc - sumHt) / sumHt) * 100;
  if (rate < 0 || rate > 30) return null;
  return Math.round((rate + Number.EPSILON) * 100) / 100;
}

/**
 * Multi-facture certificats — TVA compatibility of an invoice selection.
 *
 * A certificat applies ONE TVA rate to its net. When several factures are
 * grouped onto one certificat, every facture must be consistent with the
 * aggregate effective rate to the cent, otherwise the certificat's TVA line
 * would misstate the tax at least one facture actually carries (e.g. a 10%
 * rénovation facture grouped with a 20% supplies facture). Mixed selections
 * are rejected; the operator issues separate certificats instead.
 *
 * Tolerance: 2 cents per facture (independent roundings of HT→TTC).
 */
export interface InvoiceTvaLike {
  amountHt: string | number;
  amountTtc: string | number;
}

export interface SupplierDirectPaymentInvoiceLike extends InvoiceTvaLike {
  tvaAmount: string | number;
}

export type SupplierDirectPaymentTotalsResult =
  | {
      ok: true;
      totalWorksHt: number;
      tvaAmount: number;
      netToPayHt: number;
      netToPayTtc: number;
      effectiveTvaRatePercent: number;
    }
  | {
      ok: false;
      reason: "invalid_amount" | "inconsistent_tva";
      offendingIndex: number | null;
    };

/**
 * Supplier direct-payment certificats pay the selected invoices exactly as
 * approved. They never enter the contractor works waterfall: no cumulative
 * progress, retenue, prorata or acompte recoupment is involved.
 */
export function computeSupplierDirectPaymentTotals(
  invoices: ReadonlyArray<SupplierDirectPaymentInvoiceLike>,
): SupplierDirectPaymentTotalsResult {
  if (invoices.length === 0) {
    return { ok: false, reason: "invalid_amount", offendingIndex: null };
  }

  let sumHt = 0;
  let sumTva = 0;
  let sumTtc = 0;
  for (let i = 0; i < invoices.length; i++) {
    const invoice = invoices[i];
    const ht =
      typeof invoice.amountHt === "number"
        ? invoice.amountHt
        : Number(invoice.amountHt);
    const tva =
      typeof invoice.tvaAmount === "number"
        ? invoice.tvaAmount
        : Number(invoice.tvaAmount);
    const ttc =
      typeof invoice.amountTtc === "number"
        ? invoice.amountTtc
        : Number(invoice.amountTtc);
    if (
      !Number.isFinite(ht) ||
      !Number.isFinite(tva) ||
      !Number.isFinite(ttc) ||
      ht <= 0 ||
      tva < 0 ||
      ttc <= 0
    ) {
      return { ok: false, reason: "invalid_amount", offendingIndex: i };
    }
    if (roundCurrency(ht + tva) !== roundCurrency(ttc)) {
      return { ok: false, reason: "inconsistent_tva", offendingIndex: i };
    }
    sumHt += ht;
    sumTva += tva;
    sumTtc += ttc;
  }

  const totalWorksHt = roundCurrency(sumHt);
  const tvaAmount = roundCurrency(sumTva);
  const netToPayTtc = roundCurrency(sumTtc);
  if (roundCurrency(totalWorksHt + tvaAmount) !== netToPayTtc) {
    return { ok: false, reason: "inconsistent_tva", offendingIndex: null };
  }
  const effectiveTvaRatePercent =
    computeEffectiveTvaRatePercent(totalWorksHt, netToPayTtc);
  if (effectiveTvaRatePercent == null) {
    return { ok: false, reason: "inconsistent_tva", offendingIndex: null };
  }

  return {
    ok: true,
    totalWorksHt,
    tvaAmount,
    netToPayHt: totalWorksHt,
    netToPayTtc,
    effectiveTvaRatePercent,
  };
}

export function checkInvoiceSetTvaCompatibility(invoices: ReadonlyArray<InvoiceTvaLike>):
  | { ok: true; effectiveRatePercent: number }
  | { ok: false; effectiveRatePercent: number | null; offendingIndex: number | null } {
  const parsed = invoices.map((inv) => ({
    ht: typeof inv.amountHt === "number" ? inv.amountHt : parseFloat(inv.amountHt),
    ttc: typeof inv.amountTtc === "number" ? inv.amountTtc : parseFloat(inv.amountTtc),
  }));
  const sumHt = parsed.reduce((s, p) => s + (Number.isFinite(p.ht) ? p.ht : NaN), 0);
  const sumTtc = parsed.reduce((s, p) => s + (Number.isFinite(p.ttc) ? p.ttc : NaN), 0);
  const rate = computeEffectiveTvaRatePercent(sumHt, sumTtc);
  if (rate == null) return { ok: false, effectiveRatePercent: null, offendingIndex: null };
  for (let i = 0; i < parsed.length; i++) {
    const { ht, ttc } = parsed[i];
    if (!Number.isFinite(ht) || !Number.isFinite(ttc) || ht <= 0) {
      return { ok: false, effectiveRatePercent: rate, offendingIndex: i };
    }
    const expectedTtc = roundCurrency(ht * (1 + rate / 100));
    if (Math.abs(ttc - expectedTtc) > 0.02) {
      return { ok: false, effectiveRatePercent: rate, offendingIndex: i };
    }
  }
  return { ok: true, effectiveRatePercent: rate };
}

/**
 * Task #243 — Authoritative Certificat de Paiement deduction math.
 *
 * A certificat is CUMULATIVE: `totalWorksHt` is the gross approved works to
 * date and `previousPayments` is the cumulative net already certified. Both the
 * Retenue de Garantie and the Compte Prorata are computed on the gross
 * cumulative, then the per-period movement is derived as
 * `cumulative − Σ(prior certificats' deductions)` so rounding never compounds
 * across periods (the anti-compounding invariant from the spec).
 *
 * - Retenue is bypassed (0) when the contractor furnished a bank guarantee.
 * - Prorata is bypassed (0) when the marché is the project's prorata manager.
 * - An explicit architect override replaces the computed cumulative figure for
 *   either deduction (edge cases); the period delta is recomputed from it.
 */
// Task #462 — acompte recoupment (remboursement d'acompte). A deposit paid
// on the devis must be recovered on the certificats or the contractor gets
// paid twice. The rule lives on the marché:
//   'asap'              — recoup the full deposit as soon as available net allows.
//   'percent'           — each certificat recoups (percent% × deposit), cumulative.
//   'progress_threshold'— nothing until gross cumulative progress reaches
//                         thresholdPercent of the contract total, then full
//                         recoupment. Degrades to 'asap' when the contract
//                         total is unknown (safer against double payment).
export type AcompteRecoupmentRule = "asap" | "percent" | "progress_threshold";

export interface CertificatDeductionInput {
  totalWorksHt: number;
  pvMvAdjustment: number;
  previousPayments: number;
  retenuePercent: number;
  hasBankGuarantee: boolean;
  prorataPercent: number;
  isProrataManager: boolean;
  priorCumulativeRetenue: number;
  priorCumulativeProrata: number;
  retenueOverride?: number | null;
  prorataOverride?: number | null;
  tvaRate?: number;
  /** Task #462 — total deposit actually PAID on the contractor's devis. */
  paidAcompteAmount?: number;
  /** Cumulative recoupment already taken by prior certificats. */
  priorCumulativeAcompteRecoupment?: number;
  acompteRecoupmentRule?: AcompteRecoupmentRule;
  /** For rule 'percent': % of the deposit recouped per certificat. */
  acompteRecoupmentPercent?: number | null;
  /** For rule 'progress_threshold': progress % that unlocks recoupment. */
  acompteRecoupmentThresholdPercent?: number | null;
  /** Contract total HT (marché) used for threshold progress; null = unknown. */
  contractTotalHt?: number | null;
  /** Task #464 — this certificat is the solde (final) certificat of its marché. */
  isSolde?: boolean;
  /**
   * Task #464 — explicit architect release of the retenue de garantie.
   * Only effective on a solde certificat: the cumulative retenue withheld
   * to date is added BACK into the net to pay as a distinct positive line
   * (never a rate change). Default false ⇒ holdback stays withheld.
   */
  releaseRetenue?: boolean;
}

export interface CertificatDeductionResult {
  grossCumulativeHt: number;
  cumulativeRetenue: number;
  periodRetenue: number;
  cumulativeProrata: number;
  periodProrata: number;
  cumulativeAcompteRecoupment: number;
  periodAcompteRecoupment: number;
  /** Task #464 — retenue added back on a released solde certificat (else 0). */
  retenueReleaseAmount: number;
  netToPayHt: number;
  tvaAmount: number;
  netToPayTtc: number;
}

export function computeCertificatDeductions(input: CertificatDeductionInput): CertificatDeductionResult {
  const tvaRate = input.tvaRate ?? DEFAULT_TVA_RATE;
  const grossCumulativeHt = roundCurrency(input.totalWorksHt + input.pvMvAdjustment);

  const cumulativeRetenue = input.retenueOverride != null
    ? roundCurrency(input.retenueOverride)
    : input.hasBankGuarantee
      ? 0
      : roundCurrency(grossCumulativeHt * input.retenuePercent / 100);
  const periodRetenue = roundCurrency(cumulativeRetenue - input.priorCumulativeRetenue);

  const cumulativeProrata = input.prorataOverride != null
    ? roundCurrency(input.prorataOverride)
    : input.isProrataManager
      ? 0
      : roundCurrency(grossCumulativeHt * input.prorataPercent / 100);
  const periodProrata = roundCurrency(cumulativeProrata - input.priorCumulativeProrata);

  // Task #462 — acompte recoupment. The deposit was paid OUTSIDE the
  // certificat waterfall, so `previousPayments` (Σ prior net HT) does NOT
  // contain it; without this step it would never be recovered and the
  // contractor would be paid twice. Cumulative-first like retenue/prorata,
  // but only the PERIOD movement is subtracted from this period's net
  // (prior recoupments already reduced prior nets).
  const paidAcompte = roundCurrency(Math.max(0, input.paidAcompteAmount ?? 0));
  const priorRecouped = roundCurrency(
    Math.min(paidAcompte, Math.max(0, input.priorCumulativeAcompteRecoupment ?? 0)),
  );
  const availableNetBeforeRecoupment = Math.max(
    0,
    roundCurrency(grossCumulativeHt - cumulativeRetenue - cumulativeProrata - input.previousPayments),
  );

  let rule: AcompteRecoupmentRule = input.acompteRecoupmentRule ?? "asap";
  const contractTotal = input.contractTotalHt ?? null;
  if (rule === "progress_threshold" && (contractTotal == null || contractTotal <= 0)) {
    // Unknown contract total: degrade to asap — recouping sooner can never
    // double-pay, deferring indefinitely can.
    rule = "asap";
  }

  let cumulativeTarget: number;
  if (paidAcompte <= 0) {
    cumulativeTarget = 0;
  } else if (rule === "percent") {
    const pct = Math.max(0, input.acompteRecoupmentPercent ?? 0);
    cumulativeTarget = pct > 0
      ? roundCurrency(priorRecouped + paidAcompte * pct / 100)
      : paidAcompte; // percent rule with no percent configured → recoup asap
  } else if (rule === "progress_threshold") {
    const threshold = Math.max(0, input.acompteRecoupmentThresholdPercent ?? 0);
    const progressPct = (grossCumulativeHt / (contractTotal as number)) * 100;
    cumulativeTarget = progressPct >= threshold ? paidAcompte : priorRecouped;
  } else {
    cumulativeTarget = paidAcompte;
  }

  // Clamp: never un-recoup (≥ prior), never exceed the deposit, and never
  // push this period's net below zero.
  const cumulativeAcompteRecoupment = roundCurrency(
    Math.max(
      priorRecouped,
      Math.min(cumulativeTarget, paidAcompte, priorRecouped + availableNetBeforeRecoupment),
    ),
  );
  const periodAcompteRecoupment = roundCurrency(cumulativeAcompteRecoupment - priorRecouped);

  // Task #464 — retenue de garantie release. Only a SOLDE certificat may
  // release, and only when the architect explicitly asked. The cumulative
  // retenue was withheld from every prior net (and from this period's math
  // above), so adding the full cumulative back as a positive line pays out
  // exactly what was held — never more (bank-guarantee contracts hold 0,
  // so their release line is naturally 0).
  const retenueReleaseAmount =
    input.isSolde && input.releaseRetenue ? roundCurrency(Math.max(0, cumulativeRetenue)) : 0;

  const netToPayHt = roundCurrency(
    grossCumulativeHt - cumulativeRetenue - cumulativeProrata - input.previousPayments - periodAcompteRecoupment + retenueReleaseAmount,
  );
  const tvaAmount = roundCurrency(netToPayHt * tvaRate);
  const netToPayTtc = roundCurrency(netToPayHt + tvaAmount);

  return {
    grossCumulativeHt,
    cumulativeRetenue,
    periodRetenue,
    cumulativeProrata,
    periodProrata,
    cumulativeAcompteRecoupment,
    periodAcompteRecoupment,
    retenueReleaseAmount,
    netToPayHt,
    tvaAmount,
    netToPayTtc,
  };
}

// Task #465 — client-payment reconciliation. Payments are FACTS: they
// accumulate; the certificat counts as fully paid only when the summed
// amounts cover the TTC total (roundCurrency compare). Over-payment is
// flagged but never blocks recording — real life happens.
export interface CertificatPaymentState {
  paidToDate: number;
  outstanding: number;
  fullyPaid: boolean;
  overpaid: boolean;
}

export function computeCertificatPaymentState(
  netToPayTtc: number,
  paymentAmounts: number[],
): CertificatPaymentState {
  const paidToDate = roundCurrency(paymentAmounts.reduce((s, a) => s + a, 0));
  const total = roundCurrency(netToPayTtc);
  const outstanding = roundCurrency(Math.max(0, total - paidToDate));
  return {
    paidToDate,
    outstanding,
    fullyPaid: paymentAmounts.length > 0 && paidToDate >= total,
    overpaid: paidToDate > total,
  };
}

export function formatCurrencyEur(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

export function formatCurrencyNoSymbol(value: number): string {
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + " \u20AC";
}

export function numberToFrenchWords(n: number): string {
  if (n === 0) return "Z\u00C9RO EUROS";

  const units = ["", "UN", "DEUX", "TROIS", "QUATRE", "CINQ", "SIX", "SEPT", "HUIT", "NEUF",
    "DIX", "ONZE", "DOUZE", "TREIZE", "QUATORZE", "QUINZE", "SEIZE", "DIX-SEPT", "DIX-HUIT", "DIX-NEUF"];
  const tens = ["", "", "VINGT", "TRENTE", "QUARANTE", "CINQUANTE", "SOIXANTE", "SOIXANTE", "QUATRE-VINGT", "QUATRE-VINGT"];

  function chunk(num: number): string {
    if (num === 0) return "";
    if (num < 20) return units[num];
    if (num < 70) {
      const t = Math.floor(num / 10);
      const u = num % 10;
      if (u === 0) return tens[t];
      if (u === 1 && t !== 8) return `${tens[t]} ET UN`;
      return `${tens[t]}-${units[u]}`;
    }
    if (num < 80) {
      const u = num - 60;
      if (u === 11) return "SOIXANTE ET ONZE";
      return `SOIXANTE-${units[u]}`;
    }
    if (num < 100) {
      const u = num - 80;
      if (u === 0) return "QUATRE-VINGTS";
      return `QUATRE-VINGT-${units[u]}`;
    }
    if (num < 200) {
      const r = num - 100;
      if (r === 0) return "CENT";
      return `CENT ${chunk(r)}`;
    }
    if (num < 1000) {
      const h = Math.floor(num / 100);
      const r = num % 100;
      if (r === 0) return `${units[h]} CENTS`;
      return `${units[h]} CENT ${chunk(r)}`;
    }
    return "";
  }

  const rounded = roundCurrency(n);
  let euros = Math.floor(rounded);
  let cents = Math.round((rounded - euros) * 100);

  if (cents >= 100) {
    euros += 1;
    cents -= 100;
  }

  let result = "";

  if (euros >= 1000000) {
    const millions = Math.floor(euros / 1000000);
    const remainder = euros % 1000000;
    result += millions === 1 ? "UN MILLION" : `${chunk(millions)} MILLIONS`;
    if (remainder > 0) result += " " + buildThousands(remainder);
  } else if (euros > 0) {
    result = buildThousands(euros);
  } else {
    result = "Z\u00C9RO";
  }

  function buildThousands(num: number): string {
    if (num === 0) return "";
    if (num < 1000) return chunk(num);
    const thousands = Math.floor(num / 1000);
    const remainder = num % 1000;
    let prefix = chunk(thousands);
    prefix = prefix.replace(/CENTS$/, "CENT").replace(/VINGTS$/, "VINGT");
    let s = thousands === 1 ? "MILLE" : `${prefix} MILLE`;
    if (remainder > 0) s += " " + chunk(remainder);
    return s;
  }

  result += " EURO" + (euros !== 1 ? "S" : "");
  if (cents > 0) {
    result += ` ET ${chunk(cents)} CENTIME${cents !== 1 ? "S" : ""}`;
  }

  return result.trim();
}
