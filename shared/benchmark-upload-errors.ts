export const BENCHMARK_UPLOAD_ERROR_CODES = {
  PDF_INVALID_MAGIC: "PDF_INVALID_MAGIC",
  PDF_PASSWORD_PROTECTED: "PDF_PASSWORD_PROTECTED",
  AI_TRANSIENT: "AI_TRANSIENT",
  NO_FILE_PROVIDED: "NO_FILE_PROVIDED",
  BENCHMARK_PARSE_FAILED: "BENCHMARK_PARSE_FAILED",
  BENCHMARK_CONTRACTOR_REQUIRED: "BENCHMARK_CONTRACTOR_REQUIRED",
  BENCHMARK_UPLOAD_FAILED: "BENCHMARK_UPLOAD_FAILED",
} as const;

export type BenchmarkUploadErrorCode =
  (typeof BENCHMARK_UPLOAD_ERROR_CODES)[keyof typeof BENCHMARK_UPLOAD_ERROR_CODES];

const TITLES: Record<BenchmarkUploadErrorCode, string> = {
  PDF_INVALID_MAGIC: "Not a valid PDF file",
  PDF_PASSWORD_PROTECTED: "PDF is password-protected",
  AI_TRANSIENT: "AI extraction temporarily unavailable",
  NO_FILE_PROVIDED: "No file provided",
  BENCHMARK_PARSE_FAILED: "Could not extract benchmark data",
  BENCHMARK_CONTRACTOR_REQUIRED: "Contractor required",
  BENCHMARK_UPLOAD_FAILED: "Benchmark upload failed",
};

export function getBenchmarkUploadErrorTitle(code: string | undefined | null): string {
  if (code && code in TITLES) {
    return TITLES[code as BenchmarkUploadErrorCode];
  }
  return "Upload failed";
}
