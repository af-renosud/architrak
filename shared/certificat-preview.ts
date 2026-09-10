export type CertificatRetentionSource =
  | "default"
  | "marche"
  | "override"
  | "bank_guarantee";

export interface CertificatDeductionExplanation {
  /** Gross cumulative works after applying the PV/MV adjustment. */
  grossCumulativeHt: string;
  pvMvAdjustment: string;
  previousPayments: string;
  retention: {
    /** The rule which determined the cumulative retention amount. */
    source: CertificatRetentionSource;
    /** Configured/default rate, even when an override/guarantee bypasses it. */
    ratePercent: string;
    rateSource: "default" | "marche";
    /** HT amount to which the configured/default rate applies. */
    baseHt: string;
  };
}