import type { ActionRequirement } from "@/components/ui/blocked-action";
import { canSendCertificat, hasCertificatDeliveryEvidence, type CertificatWithDelivery } from "@/lib/certificat-delivery";

/** Mirrors presentation eligibility only. Sealing, invoice and delivery checks remain server-owned. */
export function certificateSendRequirements(cert: CertificatWithDelivery, onReview?: () => void): ActionRequirement[] {
  if (canSendCertificat(cert)) return [];
  if (hasCertificatDeliveryEvidence(cert)) return [{ id: "delivered", kind: "readonly", message: "This certificate has already been emailed. Use the existing delivery record." }];
  if (cert.status === "superseded" || cert.status === "paid") return [{ id: "status", kind: "readonly", message: `This certificate is ${cert.status}. A new email cannot be sent from this state.` }];
  return [{ id: "ready", message: "Mark this certificate Ready before sending. Review its figures and banking details first.", onResolve: onReview, linkLabel: "Go to certificate review" }];
}
