import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { ArchitectCorrectionError, architectCorrectionService } from "../services/architect-quotation-correction";
import { architectCorrectionSaveSchema } from "../../shared/architect-quotation";
import { suggestArchitectTranslation } from "../services/devis-translation";
import { readSourceVat } from "../services/quotation-vat-recovery";
import { storage } from "../storage";
import { getDocumentBuffer } from "../storage/object-storage";
import { pool } from "../db";
import { createHash } from "node:crypto";

export function createArchitectCorrectionRouter(service = architectCorrectionService) {
const router = Router();
// This is a single-firm deployment: all session-authenticated Renosud operators
// have project access (same perimeter as the other project/devis routes).
router.use("/api/devis/:id/architect-correction", requireAuth);
router.get("/api/devis/:id/architect-correction/recovered-content", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid quotation ID." });
    const current = await service.get(id);
    const quotation = await storage.getDevis(id);
    if (current.blockedReason || !quotation?.pdfStorageKey)
      return res.status(409).json({ message: current.blockedReason ?? "Original quotation PDF unavailable." });
    const candidate = (await pool.query(`SELECT id,snapshot FROM quotation_extraction_events
      WHERE devis_id=$1 AND kind='attempt' AND outcome IN ('failed','prepared')
        AND snapshot ? 'extraction' AND snapshot ? 'sourceDigest' ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    if (!candidate) return res.json({ candidate: null });
    const sourceDigest = createHash("sha256").update(await getDocumentBuffer(quotation.pdfStorageKey)).digest("hex");
    if (candidate.snapshot.sourceDigest !== sourceDigest)
      return res.status(409).json({ message: "The recovered text is from an older PDF. Re-scrape the current original before comparing." });
    const extraction = candidate.snapshot.extraction;
    return res.json({ candidate: { attemptId: candidate.id, sourceDigest, expectedVersion: current.version,
      headerFr: typeof extraction.description === "string" ? extraction.description : "",
      lines: (Array.isArray(extraction.lineItems) ? extraction.lineItems : []).map((line: any, index: number) => ({
        index, descriptionFr: String(line.description ?? ""), quantity: line.quantity ?? null,
        unit: line.unit ?? "", unitPriceHt: line.unitPrice ?? null, totalHt: line.total ?? null,
      })) } });
  } catch (error) { next(error); }
});
router.post("/api/devis/:id/architect-correction/source-vat", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid quotation ID." });
    const snapshot = await service.get(id);
    if (snapshot.blockedReason || snapshot.financialBlockedReason) return res.status(409).json({ message: snapshot.blockedReason || snapshot.financialBlockedReason });
    if (snapshot.version !== req.body?.expectedVersion) return res.status(409).json({ message: "Quotation changed. Reopen the editor before recovering VAT." });
    const devis = await storage.getDevis(id);
    if (!devis?.pdfStorageKey) return res.status(422).json({ message: "Original PDF is unavailable." });
    try { res.json(await readSourceVat(await getDocumentBuffer(devis.pdfStorageKey), snapshot)); }
    catch (error) { res.status(422).json({ message: error instanceof Error ? error.message : "VAT recovery failed." }); }
  } catch (error) { next(error); }
});
for (const operation of ["get", "save", "confirm"] as const) {
  const path = `/api/devis/:id/architect-correction${operation === "confirm" ? "/source-baseline" : ""}`;
  const method = operation === "get" ? "get" : operation === "save" ? "put" : "post";
  router[method](path, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const actorId = req.session.userId;
      if (!actorId) return res.status(401).json({ message: "Authentication required" });
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid quotation ID." });
      const result = operation === "get" ? await service.get(id)
        : operation === "save" ? await service.save(id, req.body, actorId)
          : await service.confirm(id, req.body, actorId);
      res.json(result);
    } catch (error) {
      if (error instanceof ArchitectCorrectionError) return res.status(error.status).json({ message: error.message, code: error.code, ...(error.issues ? { issues: error.issues } : {}) });
      next(error);
    }
  });
}
router.post("/api/devis/:id/architect-correction/translation-suggestions", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid quotation ID." });
    const parsed = architectCorrectionSaveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0].message });
    const { expectedVersion, ...draft } = parsed.data;
    const current = await service.get(id);
    if (expectedVersion !== current.version) return res.status(409).json({ message: "The quotation changed. Your draft has not been overwritten." });
    if (current.blockedReason) return res.status(409).json({ message: current.blockedReason });
    const suggestion = await suggestArchitectTranslation(draft);
    res.json({ expectedVersion, suggestion });
  } catch (error) { next(error); }
});
return router;
}
export default createArchitectCorrectionRouter();
