import { describe, it, expect } from "vitest";
import {
  DEVIS_UPLOAD_ERROR_CODES,
  getDevisUploadErrorTitle,
} from "../devis-upload-errors";

describe("getDevisUploadErrorTitle", () => {
  it("maps each known code to a specific user-facing toast title", () => {
    const expected: Record<string, string> = {
      PDF_INVALID_MAGIC: "Not a valid PDF file",
      PDF_PASSWORD_PROTECTED: "PDF is password-protected",
      AI_TRANSIENT: "AI extraction temporarily unavailable",
      DEVIS_PARSE_FAILED: "Could not extract devis data",
      NO_CONTRACTORS_SYNCED: "No contractors synced from ArchiDoc",
      DEVIS_CONTRACTOR_NOT_FOUND: "Contractor not found in ArchiTrak",
      NO_FILE_PROVIDED: "No file provided",
      DEVIS_UPLOAD_FAILED: "Upload failed",
    };
    for (const code of Object.values(DEVIS_UPLOAD_ERROR_CODES)) {
      expect(getDevisUploadErrorTitle(code)).toBe(expected[code]);
    }
  });

  it("falls back to a generic title for unknown / missing codes", () => {
    expect(getDevisUploadErrorTitle(undefined)).toBe("Upload failed");
    expect(getDevisUploadErrorTitle(null)).toBe("Upload failed");
    expect(getDevisUploadErrorTitle("")).toBe("Upload failed");
    expect(getDevisUploadErrorTitle("SOMETHING_ELSE")).toBe("Upload failed");
  });

  it("each title is distinct so users can tell error categories apart", () => {
    const titles = Object.values(DEVIS_UPLOAD_ERROR_CODES).map((c) =>
      getDevisUploadErrorTitle(c),
    );
    expect(new Set(titles).size).toBe(titles.length);
  });
});
