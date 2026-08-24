export const CERTIFICATE_TRACKS = [
  "contractor_works",
  "supplier_direct_payment",
] as const;

export type CertificateTrack = (typeof CERTIFICATE_TRACKS)[number];

export const SUPPLIER_DIRECT_PAYMENT_STATUSES = [
  "eligible",
  "not_eligible",
  "suspended",
] as const;

export type SupplierDirectPaymentStatus =
  (typeof SUPPLIER_DIRECT_PAYMENT_STATUSES)[number];

export const SUPPLIER_PAYMENT_READINESS_SCHEMA_VERSION =
  "archidoc_supplier_payment_readiness_v1" as const;

export interface SupplierPaymentPrimaryContact {
  id: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  mobile: string | null;
}

export interface SupplierPaymentBankingSnapshot {
  accountHolderName: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  bankingVerificationStatus: "unverified" | "verified" | "rejected";
  bankingVerifiedAt: string | null;
  bankingVerifiedBy: {
    id: string;
    displayName: string;
  } | null;
  bankingVerificationMethod:
    | "manual_rib_review"
    | "bank_account_check"
    | "imported_verified"
    | null;
  ribDocument: {
    id: string;
    fileName: string;
    mimeType: "application/pdf";
    sha256: string;
    downloadPath: string;
    updatedAt: string;
  } | null;
}

export interface SupplierProjectPaymentAssignment {
  id: string;
  projectId: string;
  directPaymentStatus: SupplierDirectPaymentStatus;
  validFrom: string | null;
  validUntil: string | null;
  reason: string | null;
  updatedAt: string;
}

/**
 * The payment-safe subset consumed by the certificat core.
 *
 * Task #669 will populate this from the frozen ArchiDoc v1 feed. Until then
 * the storage loader returns no snapshot and the core fails closed.
 */
export interface SupplierPaymentReadinessMirrorSnapshot {
  provenance: {
    schemaVersion: typeof SUPPLIER_PAYMENT_READINESS_SCHEMA_VERSION;
    /** Monotonic ArchiDoc readiness-feed sequence that produced this view. */
    sourceSequence: string;
    /** Time the immutable mirror snapshot was captured in ArchiTrak. */
    capturedAt: string;
    /** Canonical SHA-256 of the mirrored supplier + selected assignment. */
    contentSha256: string;
  };
  supplier: {
    id: string;
    partnerType: "supplier";
    name: string;
    siret: string | null;
    address1: string | null;
    address2: string | null;
    town: string | null;
    postcode: string | null;
    countryCode: string | null;
    isActive: boolean;
    primaryContact: SupplierPaymentPrimaryContact | null;
    banking: SupplierPaymentBankingSnapshot | null;
    updatedAt: string;
  };
  assignment: SupplierProjectPaymentAssignment | null;
}

export interface SupplierPaymentReadinessSnapshot
  extends Omit<SupplierPaymentReadinessMirrorSnapshot, "assignment"> {
  assignment: SupplierProjectPaymentAssignment;
}