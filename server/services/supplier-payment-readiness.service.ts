import { storage } from "../storage";
import { createHash } from "crypto";
import {
  ibansMatch,
  normaliseBic,
  validateBic,
  validateIban,
} from "@shared/iban";
import {
  SUPPLIER_PAYMENT_READINESS_SCHEMA_VERSION,
  type SupplierPaymentReadinessMirrorSnapshot,
  type SupplierPaymentReadinessSnapshot,
} from "@shared/supplier-payment-readiness";
import {
  ArchidocFetchError,
  fetchSupplierPaymentCertificateHandoff,
  SupplierPaymentCertificateNotReadyError,
  verifySupplierProtectedRib,
} from "../archidoc/sync-client";

export type SupplierPaymentReadinessBlocker =
  | "partner_not_found"
  | "partner_not_supplier"
  | "partner_not_archidoc_linked"
  | "partner_archidoc_orphaned"
  | "project_not_found"
  | "project_not_archidoc_linked"
  | "readiness_not_synchronised"
  | "snapshot_provenance_invalid"
  | "snapshot_identity_mismatch"
  | "supplier_inactive"
  | "supplier_identity_incomplete"
  | "supplier_contact_incomplete"
  | "supplier_banking_unverified"
  | "supplier_banking_invalid"
  | "supplier_banking_canonical_mismatch"
  | "supplier_banking_provenance_incomplete"
  | "project_assignment_mismatch"
  | "project_assignment_ineligible"
  | "project_assignment_not_current"
  | "handoff_not_ready"
  | "handoff_unavailable"
  | "rib_integrity_invalid";

export class SupplierPaymentReadinessError extends Error {
  readonly code = "SUPPLIER_PAYMENT_NOT_READY";

  constructor(public readonly blockers: SupplierPaymentReadinessBlocker[]) {
    super(`Supplier direct payment is not ready: ${blockers.join(", ")}`);
    this.name = "SupplierPaymentReadinessError";
  }
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidEmail(value: string | null | undefined): boolean {
  return hasText(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function evaluateSupplierPaymentReadiness(input: {
  canonicalPartner: {
    archidocId: string | null;
    archidocPartnerType: string | null;
    archidocOrphanedAt: Date | null;
    iban?: string | null;
    bic?: string | null;
  };
  projectArchidocId: string;
  issueDate: string;
  snapshot: SupplierPaymentReadinessMirrorSnapshot;
}): SupplierPaymentReadinessBlocker[] {
  const { canonicalPartner, projectArchidocId, issueDate, snapshot } = input;
  const blockers: SupplierPaymentReadinessBlocker[] = [];
  const supplier = snapshot.supplier;

  if (
    snapshot.provenance.schemaVersion !==
      SUPPLIER_PAYMENT_READINESS_SCHEMA_VERSION ||
    !/^(0|[1-9]\d*)$/.test(snapshot.provenance.sourceSequence) ||
    !Number.isFinite(Date.parse(snapshot.provenance.capturedAt)) ||
    !/^[a-f0-9]{64}$/.test(snapshot.provenance.contentSha256)
  ) {
    blockers.push("snapshot_provenance_invalid");
  }

  if (
    canonicalPartner.archidocPartnerType !== "supplier" ||
    supplier.partnerType !== "supplier" ||
    !canonicalPartner.archidocId ||
    supplier.id !== canonicalPartner.archidocId
  ) {
    blockers.push("snapshot_identity_mismatch");
  }
  if (!supplier.isActive) blockers.push("supplier_inactive");
  if (
    !hasText(supplier.name) ||
    !/^\d{14}$/.test(supplier.siret ?? "") ||
    !hasText(supplier.address1) ||
    !hasText(supplier.town) ||
    !hasText(supplier.postcode) ||
    !/^[A-Z]{2}$/.test(supplier.countryCode ?? "")
  ) {
    blockers.push("supplier_identity_incomplete");
  }
  if (
    !supplier.primaryContact ||
    !hasText(supplier.primaryContact.id) ||
    !hasText(supplier.primaryContact.name) ||
    !isValidEmail(supplier.primaryContact.email)
  ) {
    blockers.push("supplier_contact_incomplete");
  }

  const banking = supplier.banking;
  if (!banking || banking.bankingVerificationStatus !== "verified") {
    blockers.push("supplier_banking_unverified");
  } else {
    const iban = validateIban(banking.iban);
    const bicValid =
      banking.bic == null || validateBic(banking.bic).valid;
    if (!iban.valid || !bicValid) blockers.push("supplier_banking_invalid");
    if (
      !ibansMatch(canonicalPartner.iban, banking.iban) ||
      normaliseBic(canonicalPartner.bic) !== normaliseBic(banking.bic)
    ) {
      blockers.push("supplier_banking_canonical_mismatch");
    }
    if (
      !hasText(banking.accountHolderName) ||
      !banking.bankingVerifiedAt ||
      !banking.bankingVerifiedBy ||
      !hasText(banking.bankingVerifiedBy.id) ||
      !hasText(banking.bankingVerifiedBy.displayName) ||
      !banking.bankingVerificationMethod ||
      !banking.ribDocument ||
      !/^[a-f0-9]{64}$/.test(banking.ribDocument.sha256)
    ) {
      blockers.push("supplier_banking_provenance_incomplete");
    }
  }

  const assignment = snapshot.assignment;
  if (!assignment || assignment.projectId !== projectArchidocId) {
    blockers.push("project_assignment_mismatch");
  }
  if (assignment && assignment.directPaymentStatus !== "eligible") {
    blockers.push("project_assignment_ineligible");
  }
  if (
    assignment &&
    (
      (assignment.validFrom != null && issueDate < assignment.validFrom) ||
      (assignment.validUntil != null && issueDate > assignment.validUntil)
    )
  ) {
    blockers.push("project_assignment_not_current");
  }

  return Array.from(new Set(blockers));
}

export async function assertSupplierPaymentReadiness(input: {
  contractorId: number;
  projectId: number;
  issueDate?: string;
  verifyProtectedRib?: boolean;
}): Promise<SupplierPaymentReadinessSnapshot> {
  const [partner, project] = await Promise.all([
    storage.getContractor(input.contractorId),
    storage.getProject(input.projectId),
  ]);
  const blockers: SupplierPaymentReadinessBlocker[] = [];
  if (!partner) blockers.push("partner_not_found");
  if (partner && partner.archidocPartnerType !== "supplier") {
    blockers.push("partner_not_supplier");
  }
  if (partner && !partner.archidocId) blockers.push("partner_not_archidoc_linked");
  if (partner?.archidocOrphanedAt) blockers.push("partner_archidoc_orphaned");
  if (!project) blockers.push("project_not_found");
  if (project && !project.archidocId) blockers.push("project_not_archidoc_linked");
  if (blockers.length > 0 || !partner?.archidocId || !project?.archidocId) {
    throw new SupplierPaymentReadinessError(blockers);
  }

  const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10);
  let handoff;
  try {
    handoff = await fetchSupplierPaymentCertificateHandoff({
      supplierArchidocId: partner.archidocId,
      projectArchidocId: project.archidocId,
      issueDate,
    });
  } catch (error) {
    if (error instanceof SupplierPaymentCertificateNotReadyError) {
      throw new SupplierPaymentReadinessError(["handoff_not_ready"]);
    }
    if (error instanceof ArchidocFetchError) {
      throw new SupplierPaymentReadinessError(["handoff_unavailable"]);
    }
    throw error;
  }

  const capturedAt = new Date().toISOString();
  const snapshot: SupplierPaymentReadinessMirrorSnapshot = {
    provenance: {
      schemaVersion: SUPPLIER_PAYMENT_READINESS_SCHEMA_VERSION,
      // On-demand handoffs are complete point-in-time reads, not readiness-feed
      // events. The content digest, rather than a mirror cursor, pins evidence.
      sourceSequence: "0",
      capturedAt,
      contentSha256: createHash("sha256")
        .update(JSON.stringify(handoff))
        .digest("hex"),
    },
    supplier: handoff.supplier,
    assignment: handoff.assignment,
  };

  const evaluated = evaluateSupplierPaymentReadiness({
    // Identity comes from the canonical partner row. Banking is deliberately
    // supplied from the handoff itself: mirrored banking may be stale and is
    // never a fallback for certificate generation.
    canonicalPartner: {
      ...partner,
      iban: handoff.supplier.banking.iban,
      bic: handoff.supplier.banking.bic,
    },
    projectArchidocId: project.archidocId,
    issueDate,
    snapshot,
  });
  if (evaluated.length > 0) throw new SupplierPaymentReadinessError(evaluated);
  if (!snapshot.assignment) {
    throw new SupplierPaymentReadinessError(["project_assignment_mismatch"]);
  }
  if (input.verifyProtectedRib) {
    const rib = snapshot.supplier.banking?.ribDocument;
    if (!rib) {
      throw new SupplierPaymentReadinessError(["rib_integrity_invalid"]);
    }
    try {
      await verifySupplierProtectedRib({
        supplierArchidocId: snapshot.supplier.id,
        documentId: rib.id,
        expectedSha256: rib.sha256,
        downloadPath: rib.downloadPath,
      });
    } catch (error) {
      if (error instanceof ArchidocFetchError) {
        throw new SupplierPaymentReadinessError(
          error.diagnostic.code === "invalid_response"
            ? ["rib_integrity_invalid"]
            : ["handoff_unavailable"],
        );
      }
      throw error;
    }
  }
  return { ...snapshot, assignment: snapshot.assignment };
}