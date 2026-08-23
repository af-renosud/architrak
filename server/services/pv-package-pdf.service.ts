import crypto from "node:crypto";
import { PDFDocument, PageSizes } from "pdf-lib";

export const PV_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const PV_SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/x-pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
] as const;

export type PvSupportedMimeType = (typeof PV_SUPPORTED_MIME_TYPES)[number];

export class PvPackagePdfError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | "UNSUPPORTED_FILE_TYPE"
      | "INVALID_FILE"
      | "EMPTY_PDF"
      | "PDF_ENCRYPTED",
    message: string,
  ) {
    super(message);
    this.name = "PvPackagePdfError";
  }
}

export interface NormalizedPvDocument {
  pdfBuffer: Buffer;
  pdfSha256: string;
  pageCount: number;
  originalSha256: string;
}

function hasPrefix(buffer: Buffer, prefix: readonly number[]): boolean {
  return (
    buffer.length >= prefix.length &&
    prefix.every((byte, index) => buffer[index] === byte)
  );
}

function assertSupportedMagic(buffer: Buffer, mimeType: string): void {
  if (!buffer.length || buffer.length > PV_UPLOAD_MAX_BYTES) {
    throw new PvPackagePdfError(
      415,
      "INVALID_FILE",
      `Le fichier doit contenir entre 1 octet et ${PV_UPLOAD_MAX_BYTES} octets.`,
    );
  }

  if (mimeType === "application/pdf" || mimeType === "application/x-pdf") {
    if (!hasPrefix(buffer, [0x25, 0x50, 0x44, 0x46])) {
      throw new PvPackagePdfError(415, "INVALID_FILE", "Le fichier annoncé comme PDF n'est pas un PDF valide.");
    }
    return;
  }

  if (mimeType === "image/png") {
    if (!hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      throw new PvPackagePdfError(415, "INVALID_FILE", "Le fichier annoncé comme PNG n'est pas une image PNG valide.");
    }
    return;
  }

  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    if (!hasPrefix(buffer, [0xff, 0xd8, 0xff])) {
      throw new PvPackagePdfError(415, "INVALID_FILE", "Le fichier annoncé comme JPEG n'est pas une image JPEG valide.");
    }
    return;
  }

  throw new PvPackagePdfError(
    415,
    "UNSUPPORTED_FILE_TYPE",
    "Formats acceptés : PDF, PNG et JPEG.",
  );
}

export function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

async function loadPdf(buffer: Buffer): Promise<PDFDocument> {
  try {
    const document = await PDFDocument.load(buffer, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    if (document.getPageCount() < 1) {
      throw new PvPackagePdfError(415, "EMPTY_PDF", "Le PDF ne contient aucune page.");
    }
    return document;
  } catch (error) {
    if (error instanceof PvPackagePdfError) throw error;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("encrypt")) {
      throw new PvPackagePdfError(
        415,
        "PDF_ENCRYPTED",
        "Les PDF protégés par mot de passe ne sont pas acceptés.",
      );
    }
    throw new PvPackagePdfError(415, "INVALID_FILE", "Le PDF est illisible ou endommagé.");
  }
}

async function imageToPdf(buffer: Buffer, mimeType: string): Promise<Buffer> {
  try {
    const document = await PDFDocument.create();
    const image =
      mimeType === "image/png"
        ? await document.embedPng(buffer)
        : await document.embedJpg(buffer);

    const landscape = image.width > image.height;
    const [a4Width, a4Height] = PageSizes.A4;
    const pageWidth = landscape ? a4Height : a4Width;
    const pageHeight = landscape ? a4Width : a4Height;
    const margin = 36;
    const scale = Math.min(
      (pageWidth - margin * 2) / image.width,
      (pageHeight - margin * 2) / image.height,
      1,
    );
    const width = image.width * scale;
    const height = image.height * scale;
    const page = document.addPage([pageWidth, pageHeight]);
    page.drawImage(image, {
      x: (pageWidth - width) / 2,
      y: (pageHeight - height) / 2,
      width,
      height,
    });
    return Buffer.from(await document.save({ useObjectStreams: false }));
  } catch {
    throw new PvPackagePdfError(415, "INVALID_FILE", "L'image est illisible ou endommagée.");
  }
}

export async function normalizePvDocument(
  buffer: Buffer,
  mimeType: string,
): Promise<NormalizedPvDocument> {
  const normalizedMime = mimeType.toLowerCase();
  assertSupportedMagic(buffer, normalizedMime);

  const originalSha256 = sha256Buffer(buffer);
  if (normalizedMime === "application/pdf" || normalizedMime === "application/x-pdf") {
    const document = await loadPdf(buffer);
    return {
      pdfBuffer: buffer,
      pdfSha256: originalSha256,
      pageCount: document.getPageCount(),
      originalSha256,
    };
  }

  const pdfBuffer = await imageToPdf(buffer, normalizedMime);
  const document = await loadPdf(pdfBuffer);
  return {
    pdfBuffer,
    pdfSha256: sha256Buffer(pdfBuffer),
    pageCount: document.getPageCount(),
    originalSha256,
  };
}

export async function mergePvDocuments(
  orderedPdfBuffers: readonly Buffer[],
): Promise<{ buffer: Buffer; pageCount: number; sha256: string }> {
  if (orderedPdfBuffers.length === 0) {
    throw new PvPackagePdfError(422, "EMPTY_PDF", "Le dossier doit contenir un document PV principal.");
  }

  const merged = await PDFDocument.create();
  for (const buffer of orderedPdfBuffers) {
    const source = await loadPdf(buffer);
    const pageIndices = source.getPageIndices();
    const pages = await merged.copyPages(source, pageIndices);
    pages.forEach((page) => merged.addPage(page));
  }

  const output = Buffer.from(await merged.save({ useObjectStreams: false }));
  return {
    buffer: output,
    pageCount: merged.getPageCount(),
    sha256: sha256Buffer(output),
  };
}