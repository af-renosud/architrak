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

const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

function imageFileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
    return cb(new Error("Only PNG, JPEG, GIF, or WEBP images are allowed"));
  }
  cb(null, true);
}

export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: imageFileFilter,
});
