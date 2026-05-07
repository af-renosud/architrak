export const INVOICE_UPLOAD_ERROR_CODES = {
  PDF_INVALID_MAGIC: "PDF_INVALID_MAGIC",
  PDF_PASSWORD_PROTECTED: "PDF_PASSWORD_PROTECTED",
  NO_FILE_PROVIDED: "NO_FILE_PROVIDED",
  INVOICE_DEVIS_NOT_FOUND: "INVOICE_DEVIS_NOT_FOUND",
  INVOICE_UPLOAD_FAILED: "INVOICE_UPLOAD_FAILED",
} as const;

export type InvoiceUploadErrorCode =
  (typeof INVOICE_UPLOAD_ERROR_CODES)[keyof typeof INVOICE_UPLOAD_ERROR_CODES];

const TITLES: Record<InvoiceUploadErrorCode, string> = {
  PDF_INVALID_MAGIC: "Not a valid PDF file",
  PDF_PASSWORD_PROTECTED: "PDF is password-protected",
  NO_FILE_PROVIDED: "No file provided",
  INVOICE_DEVIS_NOT_FOUND: "Devis not found",
  INVOICE_UPLOAD_FAILED: "Invoice upload failed",
};

export function getInvoiceUploadErrorTitle(code: string | undefined | null): string {
  if (code && code in TITLES) {
    return TITLES[code as InvoiceUploadErrorCode];
  }
  return "Upload failed";
}
