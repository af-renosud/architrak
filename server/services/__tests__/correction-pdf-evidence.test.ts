import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { corroborateCorrectionEvidence } from "../correction-pdf-evidence";
import { extractionCorrectionSchema, type ExtractionCorrection } from "../../../shared/extraction-row-correction";

const input: ExtractionCorrection = { kind: "missing", row: { lineNumber: 1, description: "Paint",
  quantity: "2", unit: "m2", unitPriceHt: "50.00", totalHt: "100.00" },
  evidence: { page: 1, excerpt: "Paint 2 m2 50,00 100,00" }, reason: "Original page row was skipped" };

describe("correction source evidence", () => {
  it("corroborates a real PDF text layer and rejects invented excerpts", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText(input.evidence.excerpt, { font, x: 20, y: 600 });
    const pdf = Buffer.from(await doc.save());
    await expect(corroborateCorrectionEvidence(pdf, input)).resolves.toMatchObject({ mode: "text_corroborated" });
    await expect(corroborateCorrectionEvidence(pdf, {
      ...input, evidence: { page: 1, excerpt: "Commercial amendment 999.00" },
    })).rejects.toThrow("does not match");
  });
  it("marks image-only evidence as human transcription rather than claiming machine verification", async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    await expect(corroborateCorrectionEvidence(Buffer.from(await doc.save()), input))
      .resolves.toEqual({ mode: "human_transcribed_scan", pageText: null });
  });
  it("requires description and figures to exist in quoted evidence", () => {
    expect(extractionCorrectionSchema.safeParse(input).success).toBe(true);
    expect(extractionCorrectionSchema.safeParse({ ...input, row: { ...input.row, totalHt: "999.00" } }).success).toBe(false);
    expect(extractionCorrectionSchema.safeParse({ ...input, row: { ...input.row, description: "Additional work" } }).success).toBe(false);
  });
});