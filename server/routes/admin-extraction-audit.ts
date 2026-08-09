// Task #350 — Extraction completeness audit & recovery.
//
// Operator tooling to find devis whose stored extraction may be silently
// partial (prod DVT0000959: a 7-page PDF lost pages 6–7 to the old 5-page
// rasterisation cap) and to batch re-run extraction through the existing
// safeguarded rescrape path (which refuses devis with invoices/situations
// and never touches operator-edited identity fields).

import { Router } from "express";
import { z } from "zod";
import { isNotNull } from "drizzle-orm";
import { db } from "../db";
import { devis, projects } from "@shared/schema";
import { sql } from "drizzle-orm";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { getDocumentBuffer } from "../storage/object-storage";
import { getPdfPageCount } from "../gmail/document-parser";
import { rescrapeDevis } from "../services/devis-rescrape.service";

const router = Router();

interface AuditRow {
  devisId: number;
  devisCode: string | null;
  devisNumber: string | null;
  status: string;
  projectId: number;
  projectName: string | null;
  pdfPageCount: number | null;
  coveredPageCount: number | null;
  maxPageHint: number | null;
  lineItemCount: number;
  derivedTotals: boolean;
  suspectTruncated: boolean;
  reasons: string[];
}

async function auditAll(): Promise<{ rows: AuditRow[]; scanned: number; errors: Array<{ devisId: number; message: string }> }> {
  const candidates = await db
    .select({
      id: devis.id,
      devisCode: devis.devisCode,
      devisNumber: devis.devisNumber,
      status: devis.status,
      projectId: devis.projectId,
      projectName: projects.name,
      pdfStorageKey: devis.pdfStorageKey,
      aiExtractedData: devis.aiExtractedData,
      validationWarnings: devis.validationWarnings,
      lineItemCount: sql<number>`(SELECT COUNT(*)::int FROM devis_line_items dli WHERE dli.devis_id = ${devis.id})`,
      maxPageHint: sql<number | null>`(SELECT MAX(dli.pdf_page_hint)::int FROM devis_line_items dli WHERE dli.devis_id = ${devis.id})`,
    })
    .from(devis)
    .leftJoin(projects, sql`${projects.id} = ${devis.projectId}`)
    .where(isNotNull(devis.pdfStorageKey));

  const rows: AuditRow[] = [];
  const errors: Array<{ devisId: number; message: string }> = [];

  for (const c of candidates) {
    try {
      const extracted = (c.aiExtractedData ?? {}) as Record<string, unknown>;
      const coverage = extracted.extractionCoverage as
        | { pdfPageCount?: number | null; renderedPageCount?: number }
        | undefined;

      // Authoritative page count: prefer the stored coverage (no download
      // needed); fall back to opening the stored PDF with pdfinfo.
      let pdfPageCount: number | null = coverage?.pdfPageCount ?? null;
      if (pdfPageCount == null) {
        const buffer = await getDocumentBuffer(c.pdfStorageKey!);
        pdfPageCount = await getPdfPageCount(buffer);
      }
      const coveredPageCount = coverage?.renderedPageCount ?? null;

      const warnings = Array.isArray(c.validationWarnings) ? (c.validationWarnings as Array<{ field?: string }>) : [];
      const derivedTotals = warnings.some((w) => w.field === "derivedTotals" || w.field === "amountHt");

      const reasons: string[] = [];
      if (pdfPageCount != null) {
        if (coveredPageCount != null && coveredPageCount < pdfPageCount) {
          reasons.push(`extraction covered ${coveredPageCount} of ${pdfPageCount} pages`);
        }
        if (coveredPageCount == null && pdfPageCount > 5) {
          // Extracted before Task #350: only the first 5 pages were ever
          // rendered, so anything past page 5 was never seen by the AI.
          reasons.push(`legacy extraction of a ${pdfPageCount}-page PDF (pre-#350 5-page cap)`);
        }
      }
      if (derivedTotals) reasons.push("document totals were derived from line items (unverified)");

      const suspectTruncated = reasons.some((r) => r.includes("page"));
      if (reasons.length > 0) {
        rows.push({
          devisId: c.id,
          devisCode: c.devisCode ?? null,
          devisNumber: c.devisNumber ?? null,
          status: c.status,
          projectId: c.projectId,
          projectName: c.projectName ?? null,
          pdfPageCount,
          coveredPageCount,
          maxPageHint: c.maxPageHint ?? null,
          lineItemCount: c.lineItemCount ?? 0,
          derivedTotals,
          suspectTruncated,
          reasons,
        });
      }
    } catch (err: unknown) {
      errors.push({ devisId: c.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  rows.sort((a, b) => Number(b.suspectTruncated) - Number(a.suspectTruncated) || a.devisId - b.devisId);
  return { rows, scanned: candidates.length, errors };
}

router.get("/api/admin/extraction-audit", requireAuth, async (_req, res) => {
  try {
    res.json(await auditAll());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Audit failed: ${message}` });
  }
});

const rescrapeBodySchema = z
  .object({ devisIds: z.array(z.coerce.number().int().positive()).min(1).max(200) })
  .strict();

router.post(
  "/api/admin/extraction-audit/rescrape",
  requireAuth,
  validateRequest({ body: rescrapeBodySchema }),
  async (req, res) => {
    const { devisIds } = req.body as z.infer<typeof rescrapeBodySchema>;
    const results: Array<{ devisId: number; success: boolean; status: number; code?: string; message?: string }> = [];
    // Sequential on purpose — each rescrape re-invokes the AI extractor and
    // shares the upload pipeline's per-minute quota.
    for (const devisId of devisIds) {
      try {
        // Server-side draft-only guard: rescrapeDevis itself refuses devis
        // with invoices/situations, but a confirmed or signed devis with
        // neither would still be mutable — its amounts and line items are
        // financial state the audit recovery must never rewrite.
        const row = await db
          .select({ status: devis.status })
          .from(devis)
          .where(sql`${devis.id} = ${devisId}`);
        if (!row[0]) {
          results.push({ devisId, success: false, status: 404, code: "DEVIS_NOT_FOUND", message: "Devis not found" });
          continue;
        }
        if (row[0].status !== "draft") {
          results.push({
            devisId,
            success: false,
            status: 409,
            code: "NOT_DRAFT",
            message: `Devis is ${row[0].status} — only drafts may be batch re-extracted.`,
          });
          continue;
        }
        const result = await rescrapeDevis(devisId);
        results.push({
          devisId,
          success: result.success,
          status: result.status,
          code: typeof result.data.code === "string" ? result.data.code : undefined,
          message: typeof result.data.message === "string" ? result.data.message : undefined,
        });
      } catch (err: unknown) {
        results.push({
          devisId,
          success: false,
          status: 500,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    res.json({ results });
  },
);

// ── Task #356 — targeted fragment-line repair ───────────────────────────────
// Merges a phantom continuation-paragraph line back into its predecessor,
// renumbers the following lines, and realigns translations. Heavily guarded
// in the service: refuses priced lines, lines with their own item reference,
// lines with progress, and lines referenced by situations. Accepts a devis
// number (e.g. "DVP0000661") so the operator can run it on the live server
// without knowing internal ids.
const fragmentRepairSchema = z
  .object({
    devisNumber: z.string().min(3).max(40),
    fragmentLineNumber: z.coerce.number().int().min(2),
    cleanedTranslation: z.string().max(5000).optional(),
  })
  .strict();

router.post(
  "/api/admin/extraction-audit/merge-line-fragment",
  requireAuth,
  validateRequest({ body: fragmentRepairSchema }),
  async (req, res) => {
    const { devisNumber, fragmentLineNumber, cleanedTranslation } = req.body as z.infer<typeof fragmentRepairSchema>;
    try {
      // devis_number has no uniqueness constraint — resolve ALL matches and
      // refuse ambiguous input rather than silently repairing the wrong devis.
      const matches = await db
        .select({ id: devis.id, devisCode: devis.devisCode, projectId: devis.projectId })
        .from(devis)
        .where(sql`${devis.devisNumber} = ${devisNumber}`);
      if (matches.length === 0) {
        res.status(404).json({ message: `No devis with number ${devisNumber}` });
        return;
      }
      if (matches.length > 1) {
        res.status(409).json({
          message: `Devis number ${devisNumber} matches ${matches.length} devis (ids ${matches.map((m) => m.id).join(", ")}) — ambiguous; contact support to repair by internal id.`,
        });
        return;
      }
      const [row] = matches;
      const { repairLineFragment } = await import("../services/line-fragment-repair.service");
      const result = await repairLineFragment({ devisId: row.id, fragmentLineNumber, cleanedTranslation });
      res.status(result.status).json(result);
    } catch (err: unknown) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  },
);

export default router;
