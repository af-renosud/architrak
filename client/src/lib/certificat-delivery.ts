import type { Certificat } from "@shared/schema";

export type CertificatWithDelivery = Certificat & {
  sentAt?: string | null;
  sentToEmail?: string | null;
  supplierPresentation?: {
    supplier: { name: string };
  } | null;
};

export function hasCertificatDeliveryEvidence(
  cert: Pick<CertificatWithDelivery, "sentAt" | "sentToEmail">,
): boolean {
  return Boolean(cert.sentAt && cert.sentToEmail);
}

export function isFalseSentCertificat(
  cert: Pick<CertificatWithDelivery, "status" | "sentAt" | "sentToEmail">,
): boolean {
  return cert.status === "sent" && !hasCertificatDeliveryEvidence(cert);
}

export function canSendCertificat(
  cert: Pick<CertificatWithDelivery, "status" | "sentAt" | "sentToEmail">,
): boolean {
  return (
    !hasCertificatDeliveryEvidence(cert) &&
    (cert.status === "ready" || cert.status === "sent")
  );
}