import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import {
  closeDevisWithApprovedPv,
  DevisClosureError,
} from "../services/devis-closure.service";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });

router.post(
  "/api/devis/:id/close",
  requireAuth,
  validateRequest({ params: idParams }),
  async (req, res, next) => {
    try {
      const userId = Number(req.session.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const result = await closeDevisWithApprovedPv(Number(req.params.id), userId);
      return res.json({
        ...result.devis,
        alreadyClosed: result.alreadyClosed,
      });
    } catch (error) {
      if (error instanceof DevisClosureError) {
        return res.status(error.status).json({
          code: error.code,
          message: error.message,
          ...error.details,
        });
      }
      next(error);
    }
  },
);

export default router;