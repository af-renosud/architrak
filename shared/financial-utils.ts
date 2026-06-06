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
}

export interface CertificatDeductionResult {
  grossCumulativeHt: number;
  cumulativeRetenue: number;
  periodRetenue: number;
  cumulativeProrata: number;
  periodProrata: number;
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

  const netToPayHt = roundCurrency(
    grossCumulativeHt - cumulativeRetenue - cumulativeProrata - input.previousPayments,
  );
  const tvaAmount = roundCurrency(netToPayHt * tvaRate);
  const netToPayTtc = roundCurrency(netToPayHt + tvaAmount);

  return {
    grossCumulativeHt,
    cumulativeRetenue,
    periodRetenue,
    cumulativeProrata,
    periodProrata,
    netToPayHt,
    tvaAmount,
    netToPayTtc,
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
