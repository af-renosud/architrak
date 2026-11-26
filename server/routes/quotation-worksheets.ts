import { Router, type NextFunction, type Response } from "express";
import { requireAuth } from "../auth/middleware";
import { WorksheetError, worksheetService } from "../services/quotation-worksheet";
import { buildWorksheetWorkbook } from "../services/quotation-worksheet-excel";
import { quotationChecksService } from "../services/quotation-checks";

/** Architect-only client worksheets (behind the authenticated perimeter). */
export function createQuotationWorksheetRouter(service = worksheetService, checks = quotationChecksService) {
  const router = Router();
  router.use(["/api/devis/:devisId/worksheets", "/api/worksheets"], requireAuth, (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const id = (v: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw new WorksheetError("Invalid identifier.", 400);
    return n;
  };
  const fail = (error: unknown, res: Response, next: NextFunction) => {
    if (error instanceof WorksheetError) return res.status(error.status).json({ message: error.message });
    next(error);
  };

  router.get("/api/devis/:devisId/worksheets", async (req, res, next) => {
    try { res.json(await service().list(id(req.params.devisId))); } catch (e) { fail(e, res, next); }
  });
  router.post("/api/devis/:devisId/worksheets", async (req, res, next) => {
    try { res.status(201).json(await service().create(id(req.params.devisId), req.body, req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  router.get("/api/worksheets/:id", async (req, res, next) => {
    try { res.json(await service().get(id(req.params.id))); } catch (e) { fail(e, res, next); }
  });
  router.patch("/api/worksheets/:id", async (req, res, next) => {
    try { res.json(await service().updateSettings(id(req.params.id), req.body, req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  router.post("/api/worksheets/:id/duplicate", async (req, res, next) => {
    try { res.status(201).json(await service().duplicate(id(req.params.id), req.body, req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  router.post("/api/worksheets/:id/lines", async (req, res, next) => {
    try { res.status(201).json(await service().addLine(id(req.params.id), req.body, req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  router.patch("/api/worksheets/:id/lines/:lineId", async (req, res, next) => {
    try { res.json(await service().updateLine(id(req.params.id), id(req.params.lineId), req.body, req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  router.delete("/api/worksheets/:id/lines/:lineId", async (req, res, next) => {
    try { res.json(await service().deleteAddedLine(id(req.params.id), id(req.params.lineId), req.body, req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  router.get("/api/worksheets/:id/export.xlsx", async (req, res, next) => {
    try {
      const detail = await service().get(id(req.params.id));
      const { buffer } = await buildWorksheetWorkbook(detail, { checks: await checks().openPoints(detail.quotation.id) });
      const safe = `${detail.quotation.number ?? detail.quotation.code}-${detail.worksheet.title}`.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${safe}.xlsx"`);
      res.send(buffer);
    } catch (e) { fail(e, res, next); }
  });
  return router;
}
export default createQuotationWorksheetRouter();
