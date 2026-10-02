import { Router } from "express";
import { sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { db } from "../db";
import { requireAuth } from "../auth/middleware";
import { upload, assertPdfMagic } from "../middleware/upload";
import { uploadDocument, getDocumentBuffer } from "../storage/object-storage";

const router = Router();
const base = "/api/devis/:id/supporting-pdfs";
router.use(base, requireAuth);
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
router.get(base, async (req, res, next) => {
  try {
    const rows = await db.execute(sql`SELECT id,label,file_name AS "fileName",page_count AS "pageCount",byte_size AS "byteSize",position FROM devis_supporting_pdfs WHERE devis_id=${Number(req.params.id)} ORDER BY position,id`);
    res.json(rows.rows);
  } catch (e) { next(e); }
});
router.get(`${base}/:attachmentId/pdf`, async (req, res, next) => {
  try {
    const result = await db.execute(sql`SELECT storage_key FROM devis_supporting_pdfs WHERE id=${Number(req.params.attachmentId)} AND devis_id=${Number(req.params.id)}`);
    if (!result.rows[0]) throw fail("Document not found", 404);
    const bytes = await getDocumentBuffer(String(result.rows[0].storage_key));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="supporting-document.pdf"`);
    res.send(bytes);
  } catch (e) { next(e); }
});
router.post(`${base}/upload`, upload.single("file"), mutate);
router.post(`${base}/reorder`, mutate);
router.patch(`${base}/:attachmentId`, mutate);
router.delete(`${base}/:attachmentId`, mutate);
async function mutate(req: any, res: any, next: any) {
  try {
    const devisId = Number(req.params.id);
    await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`SELECT d.*,p.status AS project_status FROM devis d JOIN projects p ON p.id=d.project_id WHERE d.id=${devisId} FOR UPDATE OF d,p`);
      const devis = locked.rows[0];
      if (!devis) throw fail("Quotation not found", 404);
      if (devis.project_status === "archived" || devis.status === "void" || devis.status === "signed" || devis.date_signed || devis.archisign_envelope_id || ["client_signed_off", "sent_to_client","void"].includes(String(devis.sign_off_stage)))
        throw fail("This quotation is read-only: archived, voided or already in signing.", 409);
      const current = (await tx.execute(sql`SELECT * FROM devis_supporting_pdfs WHERE devis_id=${devisId} ORDER BY position,id`)).rows;
      if (req.path.endsWith("/upload")) {
        const file = req.file;
        if (!file || file.size > 20 * 1024 * 1024) throw fail("Choose a PDF of at most 20 MB.");
        if (current.length >= 20) throw fail("Maximum 20 supporting PDFs per quotation.");
        assertPdfMagic(file.buffer);
        let pdf;
        try { pdf = await PDFDocument.load(file.buffer); } catch { throw fail("PDF is unreadable or encrypted."); }
        const count = pdf.getPageCount();
        if (!count || count > 200) throw fail("PDF must contain 1–200 pages.");
        const key = await uploadDocument(Number(devis.project_id), file.originalname, file.buffer, "application/pdf");
        await tx.execute(sql`INSERT INTO devis_supporting_pdfs(devis_id,label,file_name,storage_key,page_count,byte_size,position) VALUES(${devisId},${file.originalname.slice(0,180)},${file.originalname},${key},${count},${file.size},${current.length ? Number(current[current.length-1].position)+1 : 0})`);
      } else if (req.path.endsWith("/reorder")) {
        const ids = req.body.ids;
        if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.some(row => row.id === id))) throw fail("Document list changed. Refresh and try again.",409);
        for (let i=0;i<ids.length;i++) await tx.execute(sql`UPDATE devis_supporting_pdfs SET position=${i} WHERE id=${ids[i]} AND devis_id=${devisId}`);
      } else {
        const id = Number(req.params.attachmentId);
        if (!current.some(row => row.id === id)) throw fail("Document not found",404);
        if (req.method === "DELETE") await tx.execute(sql`DELETE FROM devis_supporting_pdfs WHERE id=${id} AND devis_id=${devisId}`);
        else {
          const label = req.body.label;
          if (typeof label !== "string" || !label.trim() || label.trim().length > 180) throw fail("Label must contain 1–180 characters.");
          await tx.execute(sql`UPDATE devis_supporting_pdfs SET label=${label.trim()} WHERE id=${id} AND devis_id=${devisId}`);
        }
      }
      await tx.execute(sql`UPDATE devis_translations SET contexts_version=contexts_version+1,combined_pdf_storage_key=NULL WHERE devis_id=${devisId}`);
    });
    res.json({ok:true});
  } catch (e) { next(e); }
}
export default router;