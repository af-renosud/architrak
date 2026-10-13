import { useState } from "react";
import { invoiceRequestConflict } from "@shared/invoice-request-guard";
import {
  calculateInvoicePair,
  declaredTvaRates,
  invoiceDocumentTvaRate,
  openingDepositEvidence,
  resolveOpeningDeposit,
  type DepositDocument,
} from "@shared/invoice-deposit";

/** Parsed evidence is untrusted JSON, never the editable/persisted amount pair. */
export function readDepositDocument(value: unknown): DepositDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const document: DepositDocument = {};
  for (const key of ["documentType", "rawText", "openingDepositEvidenceText", "acompteTrigger"] as const) {
    if (typeof record[key] === "string") document[key] = record[key];
  }
  let malformed = false;
  for (const key of ["amountHt", "amountTtc", "tvaAmount", "tvaRate", "preTaxChargesHt", "netAPayer", "retenueDeGarantie", "acomptePaidAmountTtc"] as const) {
    if (record[key] == null) continue;
    if (typeof record[key] === "number" && Number.isFinite(record[key])) document[key] = record[key];
    else malformed = true;
  }
  if (record.autoLiquidation != null) {
    if (typeof record.autoLiquidation === "boolean") document.autoLiquidation = record.autoLiquidation;
    else malformed = true;
  }
  if (record.declaredTvaRates != null) {
    if (Array.isArray(record.declaredTvaRates) && record.declaredTvaRates.every(rate => typeof rate === "number" && Number.isFinite(rate))) {
      document.declaredTvaRates = record.declaredTvaRates;
    } else malformed = true;
  }
  if (record.openingDepositSourceTotals != null) {
    const source = record.openingDepositSourceTotals as Record<string, unknown>;
    if (typeof source === "object" && !Array.isArray(source) &&
      typeof source.amountHt === "number" && Number.isFinite(source.amountHt) &&
      typeof source.amountTtc === "number" && Number.isFinite(source.amountTtc) &&
      (source.tvaAmount == null || (typeof source.tvaAmount === "number" && Number.isFinite(source.tvaAmount)))) {
      document.openingDepositSourceTotals = {
        amountHt: source.amountHt,
        amountTtc: source.amountTtc,
        ...(typeof source.tvaAmount === "number" ? { tvaAmount: source.tvaAmount } : {}),
      };
    } else malformed = true;
  }
  // Keep the printed heading available for warnings, but fail closed on arithmetic.
  if (malformed) {
    document.declaredTvaRates = [NaN];
    document.netAPayer = NaN;
  }
  return document;
}

export function parseReviewAmount(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function useInvoiceReviewAmounts(evidence: unknown, initialHt: string, initialTtc: string) {
  const document = readDepositDocument(evidence);
  const rate = invoiceDocumentTvaRate(document);
  const declaredRates = Array.from(new Set([
    ...(document.declaredTvaRates ?? []),
    ...declaredTvaRates(document.rawText ?? ""),
    ...(document.tvaRate != null ? [document.tvaRate] : []),
  ])).filter(Number.isFinite);
  const deposit = resolveOpeningDeposit(document);
  const heading = openingDepositEvidence(document.openingDepositEvidenceText ?? "") ??
    openingDepositEvidence(document.rawText ?? "") ??
    openingDepositEvidence(document.acompteTrigger ?? "");
  const depositRequested = !!heading || !!document.openingDepositEvidenceText?.trim() || document.documentType === "acompte";
  const [amountHt, setAmountHt] = useState(initialHt);
  const [amountTtc, setAmountTtc] = useState(initialTtc);
  const [derivedField, setDerivedField] = useState<"ht" | "ttc" | null>(null);

  function editAmount(value: string, basis: "ht" | "ttc") {
    if (basis === "ht") setAmountHt(value);
    else setAmountTtc(value);
    setDerivedField(null);
    const amount = parseReviewAmount(value);
    if (amount == null || rate == null) return;
    const pair = calculateInvoicePair(amount, basis, rate);
    if (!pair) return;
    if (basis === "ht") setAmountTtc(pair.amountTtc.toFixed(2));
    else setAmountHt(pair.amountHt.toFixed(2));
    setDerivedField(basis === "ht" ? "ttc" : "ht");
  }

  function applyDeposit() {
    if (!deposit) return;
    setAmountHt(deposit.amountHt.toFixed(2));
    setAmountTtc(deposit.amountTtc.toFixed(2));
    setDerivedField("ht");
  }

  const ht = parseReviewAmount(amountHt);
  const ttc = parseReviewAmount(amountTtc);
  const matchesDeposit = !!deposit && ht != null && ttc != null &&
    Math.abs(ht - deposit.amountHt) < 0.005 && Math.abs(ttc - deposit.amountTtc) < 0.005;
  return {
    document, rate, declaredRates, deposit, heading, depositRequested,
    amountHt, amountTtc, derivedField, editAmount, applyDeposit, matchesDeposit,
    validAmounts: ht != null && ttc != null,
    requestConflict: invoiceRequestConflict({ aiExtractedData: evidence, amountHt, amountTtc }),
    tvaAmount: ht != null && ttc != null ? Math.round((ttc - ht) * 100) / 100 : null,
  };
}
