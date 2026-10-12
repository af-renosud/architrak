import { roundCurrency } from "./financial-utils";

export interface DepositDocument {
  documentType?: string;
  amountHt?: number;
  amountTtc?: number;
  tvaAmount?: number;
  tvaRate?: number;
  declaredTvaRates?: number[];
  autoLiquidation?: boolean;
  preTaxChargesHt?: number;
  netAPayer?: number;
  retenueDeGarantie?: number;
  acomptePaidAmountTtc?: number;
  openingDepositEvidenceText?: string;
  rawText?: string;
  acompteTrigger?: string;
  openingDepositSourceTotals?: { amountHt: number; amountTtc: number; tvaAmount?: number };
}

export function openingDepositEvidence(text: string) {
  const match = text.match(/(?:^|\n)\s*(FACTURE\s+D['’ʼ` ]ACOMPTE\s+(?:DE\s+)?(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:DU\s+TOTAL\s+)?T[.\s]*T[.\s]*C[.]?)(?=\s|$)/i);
  if (!match) return null;
  const context = text.slice(match.index! + match[0].length, match.index! + match[0].length + 160)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(?:paye|payee|regle|reglee|deduit|deduite|deduction|verse|versee)\b/.test(context)) return null;
  const percentage = Number(match[2].replace(",", "."));
  return percentage > 0 && percentage < 100 ? { percentage, text: match[1] } : null;
}

/** Collect explicit tax rates, not the deposit percentage or an inferred blend. */
export function declaredTvaRates(text: string): number[] {
  const matches = Array.from(text.matchAll(/T[.\s]*V[.\s]*A[.]?\s*(?:au taux de|à|:)?\s*(\d{1,2}(?:[.,]\d+)?)\s*%/gi));
  return Array.from(new Set(matches.map(m => Number(m[1].replace(",", ".")))));
}

/** Prefer the printed request after the deposit heading over a template's full-total "net à payer". */
export function printedOpeningDepositRequest(text: string, fullTtc?: number): number | null {
  const heading = openingDepositEvidence(text);
  if (!heading || fullTtc == null || !Number.isFinite(fullTtc)) return null;
  const start = text.indexOf(heading.text);
  if (start < 0) return null;
  const context = text.slice(start + heading.text.length, start + heading.text.length + 300);
  const amounts = Array.from(context.matchAll(/(?:\d{1,3}(?:[ \u00a0\u202f.]\d{3})+|\d+)[,.]\d{2}(?!\d)/g))
    .map(m => Number(m[0].replace(/[ \u00a0\u202f]/g, "").replace(/\.(?=\d{3}(?:[,.]|$))/g, "").replace(",", ".")));
  const expected = roundCurrency(fullTtc * heading.percentage / 100);
  return amounts.some(amount => Math.abs(amount - expected) < 0.011) ? expected : null;
}

function evidence(parsed: DepositDocument) {
  return openingDepositEvidence(parsed.openingDepositEvidenceText ?? "")
    ?? openingDepositEvidence(parsed.rawText ?? "")
    ?? openingDepositEvidence(parsed.acompteTrigger ?? "");
}

export function isVerifiedOpeningDeposit(parsed: DepositDocument): boolean {
  if (!["invoice", "acompte"].includes(parsed.documentType ?? "")) return false;
  const ttc = parsed.openingDepositSourceTotals?.amountTtc ?? parsed.amountTtc;
  const net = parsed.netAPayer;
  if (ttc == null || net == null || !Number.isFinite(ttc) || !Number.isFinite(net) || !(net > 0 && net < ttc)) return false;
  if ((parsed.retenueDeGarantie ?? 0) !== 0 || (parsed.acomptePaidAmountTtc ?? 0) !== 0) return false;
  const heading = evidence(parsed);
  return !!heading && Math.abs(roundCurrency(ttc * heading.percentage / 100) - roundCurrency(net)) < 0.011;
}

/** Require an extracted, single, arithmetically consistent rate. Never infer it from the amount pair. */
export function invoiceDocumentTvaRate(parsed: DepositDocument): number | null {
  if (parsed.autoLiquidation || (parsed.preTaxChargesHt ?? 0) !== 0) return null;
  const rates = [...(parsed.declaredTvaRates ?? []), ...declaredTvaRates(parsed.rawText ?? "")];
  if (typeof parsed.tvaRate === "number") rates.push(parsed.tvaRate);
  const unique = Array.from(new Set(rates));
  if (unique.length !== 1 || !Number.isFinite(unique[0]) || unique[0] < 0 || unique[0] > 100) return null;
  const source = parsed.openingDepositSourceTotals ?? parsed;
  if (source.amountHt != null && source.amountTtc != null &&
    Math.abs(roundCurrency(source.amountHt * (1 + unique[0] / 100)) - roundCurrency(source.amountTtc)) > 0.02) return null;
  return unique[0];
}

export function calculateInvoicePair(value: number, basis: "ht" | "ttc", rate: number) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(rate) || rate < 0 || rate > 100) return null;
  const amountHt = roundCurrency(basis === "ht" ? value : value / (1 + rate / 100));
  const amountTtc = roundCurrency(basis === "ttc" ? value : value * (1 + rate / 100));
  return { amountHt, amountTtc, tvaAmount: roundCurrency(amountTtc - amountHt) };
}

export function resolveOpeningDeposit(parsed: DepositDocument) {
  if (!isVerifiedOpeningDeposit(parsed)) return null;
  const rate = invoiceDocumentTvaRate(parsed);
  if (rate == null) return null;
  const source = parsed.openingDepositSourceTotals ?? parsed;
  const pair = calculateInvoicePair(parsed.netAPayer!, "ttc", rate)!;
  return {
    ...pair, rate, percentage: evidence(parsed)!.percentage,
    sourceHt: source.amountHt, sourceTtc: source.amountTtc!,
    evidenceText: evidence(parsed)!.text,
  };
}
