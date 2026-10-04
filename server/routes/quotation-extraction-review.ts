import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { requireAuth } from "../auth/middleware";
import { storage } from "../storage";
import { rescrapeDevis } from "../services/devis-rescrape.service";
import { isQuotationRescrapeRunning } from "../services/quotation-rescrape-jobs";

const router = Router();
const review = z.object({
  outcome: z.enum(["confirmed_inaccurate", "unresolved", "false_alarm", "corrected"]),
  category: z.enum(["missing_text", "wrong_association", "quantities", "prices", "totals", "other"]),
  reason: z.string().trim().min(1).max(4000),
  effortMinutes: z.number().int().min(0).max(100000),
}).strict();
router.get("/api/devis/:id/extraction-review", requireAuth, async (req, res, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const quotation = await storage.getDevis(id);
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });
    const { rows } = await pool.query(`SELECT id,created_at,kind,outcome,category,reason,effort_minutes
      FROM quotation_extraction_events WHERE devis_id=$1 ORDER BY id DESC LIMIT 200`, [id]);
    const { rows: candidates } = await pool.query(`SELECT id,snapshot FROM quotation_extraction_events
      WHERE devis_id=$1 AND kind='attempt' AND outcome='failed' AND snapshot ? 'extraction'
      AND NOT EXISTS(SELECT 1 FROM quotation_extraction_events applied WHERE applied.devis_id=$1
        AND applied.kind='replacement' AND (applied.id>quotation_extraction_events.id
          OR applied.snapshot->'humanReview'->>'attemptId'=quotation_extraction_events.id::text))
      ORDER BY id DESC LIMIT 1`, [id]);
    res.json({ events: rows, running: isQuotationRescrapeRunning(id), candidateAttemptId: candidates[0]?.id ?? null,
      evidence: candidates[0]?.snapshot?.extraction ?? quotation.aiExtractedData,
      sourcePdfUrl: `/api/devis/${id}/pdf?variant=original` });
  } catch (error) { next(error); }
});
router.post("/api/devis/:id/extraction-review/apply", requireAuth, async (req, res, next) => {
  try {
    const body = z.object({ attemptId: z.number().int().positive(),
      reason: z.string().trim().min(12).max(4000), reviewedOriginal: z.literal(true),
      initialDifferencesAreOcrErrors: z.literal(true) }).strict().safeParse(req.body);
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!body.success || !id.success) return res.status(400).json({ message: "Explicit source review and reason are required." });
    const result = await rescrapeDevis(id.data, { attemptId: body.data.attemptId,
      actorId: Number(req.session.userId), reason: body.data.reason });
    res.status(result.success ? 200 : result.status).json(result.data);
  } catch (error) { next(error); }
});
router.post("/api/devis/:id/extraction-review", requireAuth, async (req, res, next) => {
  try {
    const parsed = review.safeParse(req.body);
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!parsed.success || !id.success) return res.status(400).json({ message: "Invalid review" });
    if (!await storage.getDevis(id.data)) return res.status(404).json({ message: "Quotation not found" });
    const r = parsed.data;
    const inserted = await pool.query(`WITH target AS (
      SELECT d.id FROM devis d JOIN projects p ON p.id=d.project_id
      WHERE d.id=$1 AND p.archived_at IS NULL FOR SHARE OF d,p
    ) INSERT INTO quotation_extraction_events
      (devis_id,actor_id,kind,outcome,category,reason,effort_minutes)
      SELECT id,$2,'review',$3,$4,$5,$6 FROM target`,
    [id.data, req.session.userId, r.outcome, r.category, r.reason, r.effortMinutes]);
    if (!inserted.rowCount) return res.status(409).json({ message: "Archived projects are read-only." });
    res.status(201).json({ recorded: true });
  } catch (error) { next(error); }
});
router.get("/api/extraction-review/summary", requireAuth, async (req, res, next) => {
  try {
    const days = z.coerce.number().int().min(1).max(365).safeParse(req.query.days ?? 30);
    if (!days.success) return res.status(400).json({ message: "Invalid reporting period" });
    const { rows: [counts] } = await pool.query(`
      WITH events AS (SELECT * FROM quotation_extraction_events WHERE created_at >= now() - $1 * interval '1 day')
      SELECT count(DISTINCT devis_id) FILTER(WHERE kind='attempt')::int AS processed,
      count(DISTINCT devis_id) FILTER(WHERE kind='review' AND actor_id IS NOT NULL)::int AS reviewed,
      count(DISTINCT devis_id) FILTER(WHERE outcome='confirmed_inaccurate')::int AS inaccurate,
      COALESCE(sum(effort_minutes) FILTER(WHERE kind='review'),0)::int AS "effortMinutes",
      (SELECT count(*)::int FROM (SELECT devis_id FROM events WHERE kind='attempt'
       AND outcome='failed' GROUP BY devis_id HAVING count(*)>1) repeated) AS "repeatFailures"
      FROM events`, [days.data]);
    const { rows: categories } = await pool.query(`SELECT category,count(DISTINCT devis_id)::int AS count
      FROM quotation_extraction_events WHERE kind='review' AND outcome='confirmed_inaccurate'
      AND created_at >= now() - $1 * interval '1 day' GROUP BY category`, [days.data]);
    res.json({ ...counts, categories });
  } catch (error) { next(error); }
});
export default router;