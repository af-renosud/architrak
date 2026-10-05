import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { ArchitectCorrectionError, architectCorrectionService } from "../services/architect-quotation-correction";
import { architectCorrectionSaveSchema } from "../../shared/architect-quotation";
import { suggestArchitectTranslation } from "../services/devis-translation";

export function createArchitectCorrectionRouter(service = architectCorrectionService) {
const router = Router();
// This is a single-firm deployment: all session-authenticated Renosud operators
// have project access (same perimeter as the other project/devis routes).
router.use("/api/devis/:id/architect-correction", requireAuth);
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
      if (error instanceof ArchitectCorrectionError) return res.status(error.status).json({ message: error.message, code: error.code });
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
