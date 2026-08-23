import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  mergePvDocuments,
  normalizePvDocument,
  PvPackagePdfError,
} from "../pv-package-pdf.service";

async function makePdf(pageCount: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([300 + index, 400 + index]);
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

describe("PV package PDF utilities", () => {
  it("validates and counts uploaded PDFs without changing their bytes", async () => {
    const source = await makePdf(2);
    const normalized = await normalizePvDocument(source, "application/pdf");

    expect(normalized.pageCount).toBe(2);
    expect(normalized.pdfBuffer.equals(source)).toBe(true);
    expect(normalized.pdfSha256).toBe(normalized.originalSha256);
  });

  it("converts PNG images to a one-page A4 PDF", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const normalized = await normalizePvDocument(png, "image/png");
    const output = await PDFDocument.load(normalized.pdfBuffer);

    expect(normalized.pageCount).toBe(1);
    expect(output.getPageCount()).toBe(1);
    expect(normalized.pdfSha256).not.toBe(normalized.originalSha256);
  });

  it("merges package documents in supplied order", async () => {
    const first = await makePdf(2);
    const second = await makePdf(1);
    const merged = await mergePvDocuments([first, second]);

    expect(merged.pageCount).toBe(3);
    expect((await PDFDocument.load(merged.buffer)).getPageCount()).toBe(3);
    expect(merged.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects spoofed MIME types", async () => {
    await expect(normalizePvDocument(Buffer.from("not a pdf"), "application/pdf"))
      .rejects.toMatchObject<PvPackagePdfError>({ status: 415, code: "INVALID_FILE" });
  });
});