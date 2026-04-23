import { Router } from "express";
import { z } from "zod";
import { sql, isNotNull, and } from "drizzle-orm";
import { db } from "../db";
import { devis, devisLineItems, projects } from "@shared/schema";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { backfillOne, type DevisStats } from "../../scripts/backfill-page-hints";

const router = Router();

interface CandidateRow {
  devisId: number;
  devisCode: string | null;
  devisNumber: string | null;
  projectId: number;
  projectName: string | null;
  totalLines: number;
  missingHints: number;
}

interface StatsResponse {
  totalDevisWithPdf: number;
  devisMissingHints: number;
  lineItemsMissingHints: number;
  candidates: CandidateRow[];
}

async function computeStats(): Promise<StatsResponse> {
  // All devis with a stored source PDF — only those are eligible for the
  // backfill since the script needs to re-fetch the original document.
  // Mirrors the precondition `backfillOne` enforces (both pdfStorageKey
  // AND pdfFileName must be present, otherwise it short-circuits with
  // status=skipped-no-pdf), so the denominator here matches what an
  // operator can actually act on.
  const eligible = and(isNotNull(devis.pdfStorageKey), isNotNull(devis.pdfFileName));

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(devis)
    .where(eligible);
  const totalDevisWithPdf = totalRows[0]?.count ?? 0;

  // Per-devis aggregate of line item counts and missing-hint counts. We
  // include every devis-with-pdf even if it has zero line items so the
  // operator can still trigger a re-extraction (which will report
  // "skipped-no-lines" gracefully).
  const aggRows = await db
    .select({
      devisId: devis.id,
      devisCode: devis.devisCode,
      devisNumber: devis.devisNumber,
      projectId: devis.projectId,
      projectName: projects.name,
      totalLines: sql<number>`count(${devisLineItems.id})::int`,
      missingHints: sql<number>`count(*) filter (where ${devisLineItems.id} is not null and ${devisLineItems.pdfPageHint} is null)::int`,
    })
    .from(devis)
    .leftJoin(devisLineItems, sql`${devisLineItems.devisId} = ${devis.id}`)
    .leftJoin(projects, sql`${projects.id} = ${devis.projectId}`)
    .where(eligible)
    .groupBy(devis.id, devis.devisCode, devis.devisNumber, devis.projectId, projects.name);

  const candidates: CandidateRow[] = aggRows
    .filter((r) => (r.missingHints ?? 0) > 0)
    .map((r) => ({
      devisId: r.devisId,
      devisCode: r.devisCode ?? null,
      devisNumber: r.devisNumber ?? null,
      projectId: r.projectId,
      projectName: r.projectName ?? null,
      totalLines: r.totalLines ?? 0,
      missingHints: r.missingHints ?? 0,
    }))
    .sort((a, b) => {
      const byProject = (a.projectName ?? "").localeCompare(b.projectName ?? "");
      if (byProject !== 0) return byProject;
      return (a.devisCode ?? "").localeCompare(b.devisCode ?? "");
    });

  const lineItemsMissingHints = candidates.reduce((sum, c) => sum + c.missingHints, 0);

  return {
    totalDevisWithPdf,
    devisMissingHints: candidates.length,
    lineItemsMissingHints,
    candidates,
  };
}

router.get("/api/admin/page-hint-backfill/stats", requireAuth, async (_req, res) => {
  try {
    const stats = await computeStats();
    res.json(stats);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Stats failed: ${message}` });
  }
});

const runBodySchema = z.object({
  devisId: z.coerce.number().int().positive(),
}).strict();

router.post(
  "/api/admin/page-hint-backfill/run",
  requireAuth,
  validateRequest({ body: runBodySchema }),
  async (req, res) => {
    const { devisId } = req.body as z.infer<typeof runBodySchema>;
    try {
      // Reuses the exact per-devis logic from the CLI (re-extract + patch only
      // pdf_page_hint, leaving descriptions/totals untouched). Behaviour stays
      // in lockstep with `tsx scripts/backfill-page-hints.ts --devis-id N`.
      const stats: DevisStats = await backfillOne(devisId, false);
      res.json({ stats });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Backfill failed: ${message}`, devisId });
    }
  },
);

export default router;
