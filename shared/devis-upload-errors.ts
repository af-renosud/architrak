export const DEVIS_UPLOAD_ERROR_CODES = {
  PDF_INVALID_MAGIC: "PDF_INVALID_MAGIC",
  PDF_PASSWORD_PROTECTED: "PDF_PASSWORD_PROTECTED",
  AI_TRANSIENT: "AI_TRANSIENT",
  DEVIS_PARSE_FAILED: "DEVIS_PARSE_FAILED",
  NO_CONTRACTORS_SYNCED: "NO_CONTRACTORS_SYNCED",
  DEVIS_CONTRACTOR_NOT_FOUND: "DEVIS_CONTRACTOR_NOT_FOUND",
  NO_FILE_PROVIDED: "NO_FILE_PROVIDED",
  DEVIS_UPLOAD_FAILED: "DEVIS_UPLOAD_FAILED",
} as const;

export type DevisUploadErrorCode =
  (typeof DEVIS_UPLOAD_ERROR_CODES)[keyof typeof DEVIS_UPLOAD_ERROR_CODES];

const TITLES: Record<DevisUploadErrorCode, string> = {
  PDF_INVALID_MAGIC: "Not a valid PDF file",
  PDF_PASSWORD_PROTECTED: "PDF is password-protected",
  AI_TRANSIENT: "AI extraction temporarily unavailable",
  DEVIS_PARSE_FAILED: "Could not extract devis data",
  NO_CONTRACTORS_SYNCED: "No contractors synced from ArchiDoc",
  DEVIS_CONTRACTOR_NOT_FOUND: "Contractor not found in ArchiTrak",
  NO_FILE_PROVIDED: "No file provided",
  DEVIS_UPLOAD_FAILED: "Upload failed",
};

export function getDevisUploadErrorTitle(code: string | undefined | null): string {
  if (code && code in TITLES) {
    return TITLES[code as DevisUploadErrorCode];
  }
  return "Upload failed";
}
