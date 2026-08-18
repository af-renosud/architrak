/**
 * Task #617 — review surface for milestone "client paid" suggestions.
 * List open suggestions (globally or per project), confirm (milestone →
 * paid via the atomic service tx) or dismiss. Mounted under /api (login
 * perimeter gate), with per-route ownership enforcement in the service:
 * every operation is scoped to design contracts uploaded by the session
 * user, mirroring the milestone PATCH owner gate.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { validateRequest } from "../middleware/validate";
import { storage } from "../storage";
import {
  confirmMilestonePaymentSuggestion,
  dismissMilestonePaymentSuggestion,
  listOpenMilestonePaymentSuggestions,
} from "../services/milestone-payment-suggestions.service";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });

/** Session user id + email (actor for audit fields), or null when absent. */
async function sessionActor(req: Request): Promise<{ userId: number; email: string | null } | null> {
  const userId = (req.session as { userId?: number } | undefined)?.userId;
  if (!userId) return null;
  const user = await storage.getUser(userId);
  return { userId, email: user?.email ?? null };
}

router.get("/api/milestone-payment-suggestions", async (req, res, next) => {
  try {
    const actor = await sessionActor(req);
    if (!actor) return res.status(401).json({ message: "Authenticated session required" });
    res.json(await listOpenMilestonePaymentSuggestions(actor.userId));
  } catch (err) {
    next(err);
  }
});

router.get(
  "/api/projects/:id/milestone-payment-suggestions",
  validateRequest({ params: idParams }),
  async (req, res, next) => {
    try {
      const actor = await sessionActor(req);
      if (!actor) return res.status(401).json({ message: "Authenticated session required" });
      res.json(await listOpenMilestonePaymentSuggestions(actor.userId, Number(req.params.id)));
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/api/milestone-payment-suggestions/:id/confirm",
  validateRequest({ params: idParams }),
  async (req, res, next) => {
    try {
      const actor = await sessionActor(req);
      if (!actor) return res.status(401).json({ message: "Authenticated session required" });
      const result = await confirmMilestonePaymentSuggestion({
        suggestionId: Number(req.params.id),
        userId: actor.userId,
        actor: actor.email,
      });
      if (!result.ok) return res.status(result.status).json({ message: result.message, code: result.code });
      res.json({ suggestion: result.suggestion, milestoneId: result.milestoneId });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/api/milestone-payment-suggestions/:id/dismiss",
  validateRequest({ params: idParams }),
  async (req, res, next) => {
    try {
      const actor = await sessionActor(req);
      if (!actor) return res.status(401).json({ message: "Authenticated session required" });
      const result = await dismissMilestonePaymentSuggestion({
        suggestionId: Number(req.params.id),
        userId: actor.userId,
        actor: actor.email,
      });
      if (!result.ok) return res.status(result.status).json({ message: result.message, code: result.code });
      res.json({ suggestion: result.suggestion, milestoneId: result.milestoneId });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
