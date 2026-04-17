export const ADVISORY_CODES = {
  AMOUNT_TTC_MISMATCH: "amount_ttc_mismatch",
  AMOUNT_TTC_AUTO_CALCULATED: "amount_ttc_auto_calculated",
  AMOUNT_HT_AUTO_CALCULATED: "amount_ht_auto_calculated",
  TVA_AMOUNT_MISMATCH: "tva_amount_mismatch",
  AUTO_LIQUIDATION_TVA_RATE_NONZERO: "auto_liquidation_tva_rate_nonzero",
  AUTO_LIQUIDATION_TVA_AMOUNT_NONZERO: "auto_liquidation_tva_amount_nonzero",
  LINE_ITEMS_TOTAL_MISMATCH: "line_items_total_mismatch",
  RETENUE_GARANTIE_DEVIATION: "retenue_garantie_deviation",
  NET_A_PAYER_MISMATCH: "net_a_payer_mismatch",
  GENERIC: "generic",
} as const;

export type AdvisoryCode = (typeof ADVISORY_CODES)[keyof typeof ADVISORY_CODES];

export const ADVISORY_SEVERITIES = ["error", "warning", "info"] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

export const ADVISORY_SOURCES = ["ai_extraction", "manual"] as const;
export type AdvisorySource = (typeof ADVISORY_SOURCES)[number];

export interface ValidatorWarningLike {
  field: string;
  expected?: number | string | boolean | null;
  actual?: number | string | boolean | null;
  message: string;
  severity: "error" | "warning";
}

export function deriveAdvisoryCode(w: ValidatorWarningLike): AdvisoryCode {
  if (w.field === "amountTtc") {
    return w.severity === "error"
      ? ADVISORY_CODES.AMOUNT_TTC_MISMATCH
      : ADVISORY_CODES.AMOUNT_TTC_AUTO_CALCULATED;
  }
  if (w.field === "amountHt" && w.severity === "warning") {
    return ADVISORY_CODES.AMOUNT_HT_AUTO_CALCULATED;
  }
  if (w.field === "tvaAmount") {
    if (w.severity === "error" && typeof w.expected === "number" && w.expected === 0) {
      return ADVISORY_CODES.AUTO_LIQUIDATION_TVA_AMOUNT_NONZERO;
    }
    return ADVISORY_CODES.TVA_AMOUNT_MISMATCH;
  }
  if (w.field === "tvaRate" && w.severity === "error") {
    return ADVISORY_CODES.AUTO_LIQUIDATION_TVA_RATE_NONZERO;
  }
  if (w.field === "lineItems") return ADVISORY_CODES.LINE_ITEMS_TOTAL_MISMATCH;
  if (w.field === "retenueDeGarantie") return ADVISORY_CODES.RETENUE_GARANTIE_DEVIATION;
  if (w.field === "netAPayer") return ADVISORY_CODES.NET_A_PAYER_MISMATCH;
  return ADVISORY_CODES.GENERIC;
}
