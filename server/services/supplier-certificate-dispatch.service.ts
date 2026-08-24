import type { Certificat } from "@shared/schema";
import { storage } from "../storage";
import { deriveCertificatFromInvoices } from "./certificat-from-invoices.service";
import { assertSupplierPaymentReadiness } from "./supplier-payment-readiness.service";

export class SupplierCertificateDispatchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SupplierCertificateDispatchError";
  }
}

/**
 * Revalidates a supplier payment instruction immediately before dispatch.
 *
 * Existing sealed rows intentionally bypass only the rollout allowlist:
 * disabling new issuance must not rewrite history. Current ArchiDoc readiness,
 * exact invoice-only sources, track identity and sealed amounts remain
 * mandatory on every send surface, including Communications Hub retries.
 */
export async function assertSupplierCertificateDispatchValid(
  cert: Certificat,
): Promise<void> {
  if (cert.certificateTrack !== "supplier_direct_payment") return;

  await assertSupplierPaymentReadiness({
    contractorId: cert.contractorId,
    projectId: cert.projectId,
    issueDate: cert.dateIssued ?? undefined,
  });
  const sourceRows = await storage.getCertificatSources(cert.id);
  const sourceInvoiceIds = Array.from(
    new Set(
      sourceRows
        .map((source) => source.invoiceId)
        .filter((invoiceId): invoiceId is number => invoiceId != null),
    ),
  );
  if (
    sourceInvoiceIds.length === 0 ||
    sourceRows.some(
      (source) => source.situationId != null || source.invoiceId == null,
    )
  ) {
    throw new SupplierCertificateDispatchError(
      "SUPPLIER_CERTIFICATE_SOURCE_SET_INVALID",
      "Le paiement direct fournisseur ne possède pas un ensemble de sources facture-only valide.",
    );
  }
  const currentSourceDerivation = await deriveCertificatFromInvoices(
    sourceInvoiceIds,
    {
      allowCertificatId: cert.id,
      skipSupplierRolloutGate: cert.pdfStorageKey != null,
    },
  );
  if (!currentSourceDerivation.ok) {
    throw new SupplierCertificateDispatchError(
      currentSourceDerivation.refusal.body.code,
      currentSourceDerivation.refusal.body.message,
    );
  }
  if (
    currentSourceDerivation.derivation.certificateTrack !==
    "supplier_direct_payment"
  ) {
    throw new SupplierCertificateDispatchError(
      "CERTIFICATE_TRACK_IMMUTABLE",
      "Le partenaire n'est plus classé comme fournisseur dans ArchiDoc.",
    );
  }
  if (
    cert.pdfStorageKey &&
    (cert.totalWorksHt !==
      currentSourceDerivation.derivation.totalWorksHt ||
      cert.netToPayHt !==
        currentSourceDerivation.derivation.supplierDirectPayment.netToPayHt ||
      cert.tvaAmount !==
        currentSourceDerivation.derivation.supplierDirectPayment.tvaAmount ||
      cert.netToPayTtc !==
        currentSourceDerivation.derivation.supplierDirectPayment.netToPayTtc)
  ) {
    throw new SupplierCertificateDispatchError(
      "SUPPLIER_SOURCE_AMOUNT_CHANGED",
      "Les montants d'une facture source ont changé depuis l'émission du certificat fournisseur. Réémettez le certificat avant l'envoi.",
    );
  }
}