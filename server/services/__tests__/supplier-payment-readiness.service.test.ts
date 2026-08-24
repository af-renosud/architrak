import { describe, expect, it } from "vitest";
import {
  evaluateSupplierPaymentReadiness,
} from "../supplier-payment-readiness.service";
import type { SupplierPaymentReadinessSnapshot } from "@shared/supplier-payment-readiness";
import { insertCertificatSchema } from "@shared/schema";

const validSnapshot = (): SupplierPaymentReadinessSnapshot => ({
  provenance: {
    schemaVersion: "archidoc_supplier_payment_readiness_v1",
    sourceSequence: "42",
    capturedAt: "2026-08-20T10:01:00Z",
    contentSha256: "d".repeat(64),
  },
  supplier: {
    id: "supplier-archidoc-1",
    partnerType: "supplier",
    name: "Fournitures Exemple",
    siret: "12345678901234",
    address1: "12 rue des Artisans",
    address2: null,
    town: "Paris",
    postcode: "75011",
    countryCode: "FR",
    isActive: true,
    primaryContact: {
      id: "contact-1",
      name: "Camille Martin",
      jobTitle: "Comptabilité",
      email: "compta@example.test",
      mobile: null,
    },
    banking: {
      accountHolderName: "Fournitures Exemple",
      iban: "FR7630006000011234567890189",
      bic: "AGRIFRPP",
      bankName: "Banque Exemple",
      bankingVerificationStatus: "verified",
      bankingVerifiedAt: "2026-08-20T10:00:00Z",
      bankingVerifiedBy: {
        id: "user-1",
        displayName: "Architecte Test",
      },
      bankingVerificationMethod: "manual_rib_review",
      ribDocument: {
        id: "rib-1",
        fileName: "RIB.pdf",
        mimeType: "application/pdf",
        sha256: "a".repeat(64),
        downloadPath:
          "/api/integrations/architrak/v1/suppliers/supplier-archidoc-1/rib/rib-1",
        updatedAt: "2026-08-20T10:00:00Z",
      },
    },
    updatedAt: "2026-08-20T10:00:00Z",
  },
  assignment: {
    id: "assignment-1",
    projectId: "project-archidoc-1",
    directPaymentStatus: "eligible",
    validFrom: "2026-01-01",
    validUntil: "2026-12-31",
    reason: null,
    updatedAt: "2026-08-20T10:00:00Z",
  },
});

const canonicalPartner = {
  archidocId: "supplier-archidoc-1",
  archidocPartnerType: "supplier",
  archidocOrphanedAt: null,
  iban: "FR7630006000011234567890189",
  bic: "AGRIFRPP",
};

describe("supplier payment readiness evaluation", () => {
  it("keeps certificateTrack outside the client-write schema", () => {
    expect("certificateTrack" in insertCertificatSchema.shape).toBe(false);
  });

  it("accepts a complete, current, bank-verified supplier assignment", () => {
    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot: validSnapshot(),
      }),
    ).toEqual([]);
  });

  it("fails closed on inactive identity, contact, banking and assignment blockers", () => {
    const snapshot = validSnapshot();
    snapshot.supplier.isActive = false;
    snapshot.supplier.siret = null;
    snapshot.supplier.primaryContact!.email = null;
    snapshot.supplier.banking!.bankingVerificationStatus = "unverified";
    snapshot.assignment.directPaymentStatus = "suspended";
    snapshot.assignment.validUntil = "2026-08-23";

    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot,
      }),
    ).toEqual(
      expect.arrayContaining([
        "supplier_inactive",
        "supplier_identity_incomplete",
        "supplier_contact_incomplete",
        "supplier_banking_unverified",
        "project_assignment_ineligible",
        "project_assignment_not_current",
      ]),
    );
  });

  it("rejects banking data that differs from the canonical ArchiDoc partner", () => {
    const snapshot = validSnapshot();
    snapshot.supplier.banking!.iban = "DE89370400440532013000";

    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot,
      }),
    ).toContain("supplier_banking_canonical_mismatch");
  });

  it("reports each identity and contact blocker independently", () => {
    const inactive = validSnapshot();
    inactive.supplier.isActive = false;
    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot: inactive,
      }),
    ).toEqual(["supplier_inactive"]);

    const identity = validSnapshot();
    identity.supplier.address1 = null;
    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot: identity,
      }),
    ).toEqual(["supplier_identity_incomplete"]);

    const contact = validSnapshot();
    contact.supplier.primaryContact!.email = "not-an-email";
    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot: contact,
      }),
    ).toEqual(["supplier_contact_incomplete"]);
  });

  it("reports invalid banking and incomplete verification provenance independently", () => {
    const invalidIban = validSnapshot();
    invalidIban.supplier.banking!.iban = "FR001234";
    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner: { ...canonicalPartner, iban: "FR001234" },
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot: invalidIban,
      }),
    ).toContain("supplier_banking_invalid");

    const invalidBic = validSnapshot();
    invalidBic.supplier.banking!.bic = "INVALID";
    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner: { ...canonicalPartner, bic: "INVALID" },
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot: invalidBic,
      }),
    ).toContain("supplier_banking_invalid");

    const provenance = validSnapshot();
    provenance.supplier.banking!.bankingVerifiedBy = null;
    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot: provenance,
      }),
    ).toEqual(["supplier_banking_provenance_incomplete"]);
  });

  it("reports assignment mismatch, ineligibility and date bounds independently", () => {
    const mismatch = validSnapshot();
    mismatch.assignment.projectId = "another-project";
    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot: mismatch,
      }),
    ).toEqual(["project_assignment_mismatch"]);

    const ineligible = validSnapshot();
    ineligible.assignment.directPaymentStatus = "suspended";
    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot: ineligible,
      }),
    ).toEqual(["project_assignment_ineligible"]);

    for (const issueDate of ["2025-12-31", "2027-01-02"]) {
      expect(
        evaluateSupplierPaymentReadiness({
          canonicalPartner,
          projectArchidocId: "project-archidoc-1",
          issueDate,
          snapshot: validSnapshot(),
        }),
      ).toEqual(["project_assignment_not_current"]);
    }
  });

  it("accepts verified banking without the optional BIC", () => {
    const snapshot = validSnapshot();
    snapshot.supplier.banking!.bic = null;

    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner: { ...canonicalPartner, bic: null },
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot,
      }),
    ).toEqual([]);
  });

  it("rejects an unversioned or invalid feed snapshot", () => {
    const snapshot = validSnapshot();
    snapshot.provenance.sourceSequence = "-1";

    expect(
      evaluateSupplierPaymentReadiness({
        canonicalPartner,
        projectArchidocId: "project-archidoc-1",
        issueDate: "2026-08-24",
        snapshot,
      }),
    ).toContain("snapshot_provenance_invalid");
  });
});