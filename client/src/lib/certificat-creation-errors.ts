import { ApiError } from "@/lib/queryClient";

export type CertificatCreationErrorToast = {
  title: string;
  description: string;
  variant: "destructive";
  duration?: number;
};

export function getManualCertificatCreationErrorToast(
  error: Error,
): CertificatCreationErrorToast {
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === "ELIGIBLE_INVOICE_SOURCES_REQUIRED"
  ) {
    return {
      title: "Invoice source now available",
      description:
        "This form has been kept open. Close it, then retry from the quotation so you can create the certificate from the approved invoice source.",
      variant: "destructive",
      duration: 12000,
    };
  }

  return {
    title: "Error",
    description: error.message,
    variant: "destructive",
  };
}