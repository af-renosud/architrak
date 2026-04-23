import { Router } from "express";
import { z } from "zod";
import { desc } from "drizzle-orm";
import { db } from "../db";
import { postMergeTransientFailures } from "@shared/schema";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { clearTransientFailures } from "../operations/post-merge-failure-tracker";

const router = Router();

router.get("/api/admin/transient-failures", requireAuth, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(postMergeTransientFailures)
      .orderBy(
        desc(postMergeTransientFailures.consecutiveFailures),
        desc(postMergeTransientFailures.lastFailureAt),
      );
    res.json({ rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Listing failed: ${message}` });
  }
});

const resetBodySchema = z.object({
  sourceTag: z.string().min(1).max(200),
}).strict();

router.post(
  "/api/admin/transient-failures/reset",
  requireAuth,
  validateRequest({ body: resetBodySchema }),
  async (req, res) => {
    const { sourceTag } = req.body as z.infer<typeof resetBodySchema>;
    try {
      const result = await clearTransientFailures(sourceTag);
      res.json({ sourceTag, ...result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Reset failed: ${message}`, sourceTag });
    }
  },
);

export default router;
