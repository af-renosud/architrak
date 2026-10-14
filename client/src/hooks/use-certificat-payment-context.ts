import { useQuery } from "@tanstack/react-query";
import type { Certificat, CertificatPayment } from "@shared/schema";

export type PaymentWithEvidence = CertificatPayment & {
  invoiceAllocations?: Array<{ invoiceId: number; amount: string | number }>;
  note?: string | null;
  evidenceFileName?: string | null;
  requestId?: string | null;
};
export interface PaymentContext {
  cert: Certificat;
  invoices: Array<{ id: number; invoiceNumber: string; amountTtc: string | number }>;
  archived: boolean;
}
export function useCertificatPaymentContext(certId: number) {
  return useQuery<PaymentContext>({
    queryKey: ["/api/certificats", String(certId), "payment-context"],
  });
}
export function paymentStateReason(status: string, archived: boolean) {
  if (archived || status === "archived") return "Projet ou certificat archivé — aucun paiement ni justificatif ne peut être ajouté.";
  if (status === "draft") return "Certificat en brouillon — émettez le certificat avant d'enregistrer un paiement client.";
  if (status === "superseded") return "Certificat remplacé — utilisez le certificat en vigueur pour enregistrer un paiement ou un justificatif.";
  return null;
}
export function evidenceFileError(file: File): string | null {
  if (file.type !== "application/pdf" && !(file.type === "" && /\.pdf$/i.test(file.name))) return "Choisissez un fichier PDF.";
  if (file.size > 10 * 1024 * 1024) return "Le PDF ne doit pas dépasser 10 Mo.";
  return null;
}
export function allocationsMatch(amount: string, allocations: Array<{ amount: string | number }>) {
  return Number.isFinite(Number(amount)) && Math.round(Number(amount) * 100) === allocations.reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0);
}
