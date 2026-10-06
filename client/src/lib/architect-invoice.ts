import { ApiError } from "@/lib/queryClient";

export interface ArchitectInvoiceStatus {
  attached: boolean;
  fileName: string | null;
  locked: boolean;
  deliveryStatus: string | null;
  sentWithInvoice: boolean | null;
  historicalDeliveryUnknown: boolean;
}

export const architectInvoiceKey = (certId: number) =>
  ["/api/certificats", String(certId), "architect-invoice"] as const;

export function architectInvoiceDeliveryLabel(status: ArchitectInvoiceStatus): string | null {
  if (status.historicalDeliveryUnknown) return "Envoi historique — pièce jointe inconnue";
  if (status.sentWithInvoice === true) return "Envoyé avec facture d’architecte";
  if (status.sentWithInvoice === false) return "Envoyé sans facture d’architecte";
  return null;
}

export function isArchitectInvoiceConfirmationRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 &&
    error.code === "ARCHITECT_INVOICE_CONFIRMATION_REQUIRED";
}

export function validateArchitectInvoice(file: Pick<File, "name" | "type" | "size">): string | null {
  if (!/\.pdf$/i.test(file.name) || (file.type && file.type !== "application/pdf")) {
    return "Choisissez une facture au format PDF.";
  }
  if (file.size === 0) return "Le fichier PDF est vide.";
  if (file.size > 10 * 1024 * 1024) return "Le PDF ne doit pas dépasser 10 Mo.";
  return null;
}
