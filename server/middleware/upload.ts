import multer, { FileFilterCallback } from "multer";
import type { Request } from "express";

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function pdfFileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const ext = (file.originalname || "").toLowerCase();
  const mimeOk = file.mimetype === "application/pdf" || file.mimetype === "application/x-pdf";
  const extOk = ext.endsWith(".pdf");
  if (!mimeOk || !extOk) {
    return cb(new Error("Only PDF uploads are allowed"));
  }
  cb(null, true);
}

export function assertPdfMagic(buf: Buffer): void {
  if (!buf || buf.length < 4 || !buf.subarray(0, 4).equals(PDF_MAGIC)) {
    const err: any = new Error("Uploaded file is not a valid PDF (magic-byte check failed)");
    err.status = 415;
    throw err;
  }
}

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: pdfFileFilter,
});
