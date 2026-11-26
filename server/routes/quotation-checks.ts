import { Router, type NextFunction, type Response } from "express";
import { requireAuth } from "../auth/middleware";
import { CheckError, quotationChecksService } from "../services/quotation-checks";

/** Architect-only "points to check" on a quotation (behind the authenticated perimeter). */
export function createQuotationChecksRouter(service = quotationChecksService) {
  const router = Router();
  const base = "/api/devis/:devisId/points-to-check";
  router.use(base, requireAuth, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const id = (v: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw new CheckError("Invalid identifier.", 400);
    return n;
  };
  const fail = (error: unknown, res: Response, next: NextFunction) => {
    if (error instanceof CheckError) return res.status(error.status).json({ message: error.message });
    next(error);
  };
  router.get(base, async (req, res, next) => {
    try { res.json(await service().get(id(req.params.devisId))); } catch (e) { fail(e, res, next); }
  });
  router.post(`${base}/dismiss`, async (req, res, next) => {
    try { res.json(await service().dismiss(id(req.params.devisId), req.body, req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  router.post(`${base}/reopen`, async (req, res, next) => {
    try { res.json(await service().reopen(id(req.params.devisId), req.body, req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  router.post(`${base}/to-worksheet`, async (req, res, next) => {
    try { res.json(await service().addToWorksheet(id(req.params.devisId), req.body, req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  router.post(`${base}/ai`, async (req, res, next) => {
    try { res.json(await service().runAi(id(req.params.devisId), req.session.userId!)); } catch (e) { fail(e, res, next); }
  });
  return router;
}
export default createQuotationChecksRouter();
