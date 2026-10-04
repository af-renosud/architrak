import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractionCorrection } from "../../shared/extraction-row-correction";
import { CorrectionError } from "./duplicate-extraction";

const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

/** Corroborate text PDFs deterministically; scans remain explicitly human-transcribed evidence. */
export async function corroborateCorrectionEvidence(pdf: Buffer, input: ExtractionCorrection) {
  const dir = await mkdtemp(join(tmpdir(), "quotation-evidence-"));
  try {
    const path = join(dir, "source.pdf");
    await writeFile(path, pdf);
    const text = await new Promise<string>((resolve, reject) => execFile("pdftotext",
      ["-f", String(input.evidence.page), "-l", String(input.evidence.page), "-layout", path, "-"],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    if (!normalize(text)) return { mode: "human_transcribed_scan", pageText: null };
    if (!normalize(text).includes(normalize(input.evidence.excerpt)))
      throw new CorrectionError("The quoted evidence does not match the selected original PDF page. Copy its text exactly, including the row figures.", 400);
    return { mode: "text_corroborated", pageText: text };
  } catch (error) {
    if (error instanceof CorrectionError) throw error;
    throw new CorrectionError("Original PDF evidence could not be read. No correction was made; retry when PDF text extraction is available.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}