import { Router } from "express";
import { PDFDocument } from "pdf-lib";
import { requireAuth } from "../auth/middleware";
import { upload, assertPdfMagic } from "../middleware/upload";
import { getDocumentBuffer } from "../storage/object-storage";
import { architectInvoiceStatus, getArchitectInvoice, replaceArchitectInvoice, ArchitectInvoiceError } from "../services/certificat-architect-invoice.service";

const router = Router();
const base = "/api/certificats/:certId/architect-invoice";
router.use(base, requireAuth, (req, res, next) => {
  if (typeof req.params.certId !== "string" || !/^[1-9]\d*$/.test(req.params.certId)) return res.status(400).json({message:"Invalid certificate."});
  next();
});
router.get(base, async (req,res,next) => {
  try { res.json(await architectInvoiceStatus(Number(req.params.certId))); } catch(e) { next(e); }
});
router.get(`${base}/pdf`, async (req,res,next) => {
  try {
    const row = await getArchitectInvoice(Number(req.params.certId));
    if (!row?.storage_key) return res.status(404).json({message:"No architect invoice attached."});
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`inline; filename="architect-invoice.pdf"`);
    res.setHeader("Cache-Control","private, no-store");
    res.send(await getDocumentBuffer(row.storage_key));
  } catch(e) { next(e); }
});
router.post(base, upload.single("file"), async (req,res,next) => {
  try {
    if (!req.file || req.file.size > 10 * 1024 * 1024) return res.status(400).json({message:"Choose a PDF of at most 10 MB."});
    assertPdfMagic(req.file.buffer);
    try {
      const pdf = await PDFDocument.load(req.file.buffer);
      if (!pdf.getPageCount()) throw new Error("Empty PDF");
    } catch { return res.status(400).json({message:"The PDF is unreadable or encrypted."}); }
    res.json(await replaceArchitectInvoice(Number(req.params.certId),req.file,req.session.userId!));
  } catch(e) { next(e); }
});
router.delete(base, async (req,res,next) => {
  try { res.json(await replaceArchitectInvoice(Number(req.params.certId),null,req.session.userId!)); } catch(e) { next(e); }
});
router.use((e: any, _req: any, res: any, next: any) => {
  if (e instanceof ArchitectInvoiceError) return res.status(e.status).json({code:e.code,message:e.message});
  next(e);
});
export default router;
