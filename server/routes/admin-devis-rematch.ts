import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { matchToProject, type ParsedDocument } from "../gmail/document-parser";
import type { Devis, Project, Contractor } from "@shared/schema";

const router = Router();

interface PreviewRow {
  devisId: number;
  devisCode: string | null;
  devisNumber: string | null;
  projectId: number;
  projectName: string | null;
  currentContractorId: number;
  currentContractorName: string | null;
  suggestedContractorId: number;
  suggestedContractorName: string;
  suggestedContractorOrphaned: boolean;
  confidence: number;
  matchedFields: Record<string, string>;
  status: string;
  projectArchived: boolean;
  applicable: boolean;
  blockedReason: string | null;
}

async function computePreview(): Promise<PreviewRow[]> {
  const [projects, contractors] = await Promise.all([
    storage.getProjects({ includeArchived: true }),
    storage.getContractors(),
  ]);
  const projectById = new Map<number, Project>(projects.map((p) => [p.id, p]));
  const contractorById = new Map<number, Contractor>(contractors.map((c) => [c.id, c]));

  const allDevis: Devis[] = [];
  for (const project of projects) {
    const devisList = await storage.getDevisByProject(project.id);
    for (const d of devisList) allDevis.push(d);
  }

  const rows: PreviewRow[] = [];
  for (const devis of allDevis) {
    const aiData = devis.aiExtractedData as ParsedDocument | null;
    if (!aiData || typeof aiData !== "object") continue;

    const result = await matchToProject(aiData, projects, contractors);
    if (result.contractorId == null) continue;
    if (result.contractorId === devis.contractorId) continue;

    const suggested = contractorById.get(result.contractorId);
    if (!suggested) continue;

    const project = projectById.get(devis.projectId);
    const projectArchived = !!project?.archivedAt;
    const orphaned = !!suggested.archidocOrphanedAt;
    const isVoid = devis.status === "void";

    let blockedReason: string | null = null;
    if (isVoid) blockedReason = "Devis is void";
    else if (projectArchived) blockedReason = "Project is archived";
    else if (orphaned) blockedReason = "Suggested contractor was removed from ArchiDoc";

    rows.push({
      devisId: devis.id,
      devisCode: devis.devisCode ?? null,
      devisNumber: devis.devisNumber ?? null,
      projectId: devis.projectId,
      projectName: project?.name ?? null,
      currentContractorId: devis.contractorId,
      currentContractorName: contractorById.get(devis.contractorId)?.name ?? null,
      suggestedContractorId: suggested.id,
      suggestedContractorName: suggested.name,
      suggestedContractorOrphaned: orphaned,
      confidence: result.confidence,
      matchedFields: result.matchedFields,
      status: devis.status,
      projectArchived,
      applicable: blockedReason === null,
      blockedReason,
    });
  }

  rows.sort((a, b) => (a.projectName ?? "").localeCompare(b.projectName ?? "")
    || (a.devisCode ?? "").localeCompare(b.devisCode ?? ""));
  return rows;
}

router.get("/api/admin/devis-rematch/preview", requireAuth, async (_req, res) => {
  try {
    const rows = await computePreview();
    res.json({ rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Preview failed: ${message}` });
  }
});

const applyBodySchema = z.object({
  devisIds: z.array(z.coerce.number().int().positive()).min(1),
}).strict();

router.post(
  "/api/admin/devis-rematch/apply",
  requireAuth,
  validateRequest({ body: applyBodySchema }),
  async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const user = await storage.getUser(Number(userId));
    if (!user) return res.status(401).json({ message: "Authentication required" });

    const { devisIds } = req.body as z.infer<typeof applyBodySchema>;
    const idSet = Array.from(new Set<number>(devisIds));

    const [projects, contractors] = await Promise.all([
      storage.getProjects({ includeArchived: true }),
      storage.getContractors(),
    ]);
    const projectById = new Map<number, Project>(projects.map((p) => [p.id, p]));
    const contractorById = new Map<number, Contractor>(contractors.map((c) => [c.id, c]));

    const applied: Array<{ devisId: number; previousContractorId: number; newContractorId: number }> = [];
    const skipped: Array<{ devisId: number; reason: string }> = [];

    for (const devisId of idSet) {
      const devis = await storage.getDevis(devisId);
      if (!devis) {
        skipped.push({ devisId, reason: "Devis not found" });
        continue;
      }
      const aiData = devis.aiExtractedData as ParsedDocument | null;
      if (!aiData || typeof aiData !== "object") {
        skipped.push({ devisId, reason: "No stored extraction data" });
        continue;
      }
      const match = await matchToProject(aiData, projects, contractors);
      if (match.contractorId == null) {
        skipped.push({ devisId, reason: "Re-match returned no contractor" });
        continue;
      }
      if (match.contractorId === devis.contractorId) {
        skipped.push({ devisId, reason: "Contractor already correct" });
        continue;
      }
      if (devis.status === "void") {
        skipped.push({ devisId, reason: "Devis is void" });
        continue;
      }
      const project = projectById.get(devis.projectId);
      if (project?.archivedAt) {
        skipped.push({ devisId, reason: "Project is archived" });
        continue;
      }
      const target = contractorById.get(match.contractorId);
      if (!target) {
        skipped.push({ devisId, reason: "Suggested contractor not found" });
        continue;
      }
      if (target.archidocOrphanedAt) {
        skipped.push({ devisId, reason: "Suggested contractor was removed from ArchiDoc" });
        continue;
      }

      const previousContractorId = devis.contractorId;
      const previousContractor = contractorById.get(previousContractorId) ?? null;
      const updated = await storage.updateDevis(devisId, { contractorId: target.id });
      if (!updated) {
        skipped.push({ devisId, reason: "Update failed" });
        continue;
      }
      await storage.createDevisRefEdit({
        devisId,
        field: "contractorId",
        previousValue: `${previousContractorId}:${previousContractor?.name ?? `#${previousContractorId}`}`,
        newValue: `${target.id}:${target.name}`,
        editedByUserId: user.id,
        editedByEmail: user.email,
      });
      applied.push({ devisId, previousContractorId, newContractorId: target.id });
    }

    res.json({ applied, skipped });
  },
);

export default router;
