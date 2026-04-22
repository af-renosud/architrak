import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import { matchToProject, type ParsedDocument } from "../gmail/document-parser";
import type { Invoice, Project, Contractor } from "@shared/schema";

const router = Router();

interface PreviewRow {
  invoiceId: number;
  invoiceNumber: string | null;
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
  const [projects, contractors, allInvoices] = await Promise.all([
    storage.getProjects({ includeArchived: true }),
    storage.getContractors(),
    storage.getAllInvoices(),
  ]);
  const projectById = new Map<number, Project>(projects.map((p) => [p.id, p]));
  const contractorById = new Map<number, Contractor>(contractors.map((c) => [c.id, c]));

  const rows: PreviewRow[] = [];
  for (const invoice of allInvoices as Invoice[]) {
    const aiData = invoice.aiExtractedData as ParsedDocument | null;
    if (!aiData || typeof aiData !== "object") continue;

    const result = await matchToProject(aiData, projects, contractors);
    if (result.contractorId == null) continue;
    if (result.contractorId === invoice.contractorId) continue;

    const suggested = contractorById.get(result.contractorId);
    if (!suggested) continue;

    const project = projectById.get(invoice.projectId);
    const projectArchived = !!project?.archivedAt;
    const orphaned = !!suggested.archidocOrphanedAt;
    const isVoid = invoice.status === "void";

    let blockedReason: string | null = null;
    if (isVoid) blockedReason = "Invoice is void";
    else if (projectArchived) blockedReason = "Project is archived";
    else if (orphaned) blockedReason = "Suggested contractor was removed from ArchiDoc";

    rows.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber ?? null,
      projectId: invoice.projectId,
      projectName: project?.name ?? null,
      currentContractorId: invoice.contractorId,
      currentContractorName: contractorById.get(invoice.contractorId)?.name ?? null,
      suggestedContractorId: suggested.id,
      suggestedContractorName: suggested.name,
      suggestedContractorOrphaned: orphaned,
      confidence: result.confidence,
      matchedFields: result.matchedFields,
      status: invoice.status,
      projectArchived,
      applicable: blockedReason === null,
      blockedReason,
    });
  }

  rows.sort((a, b) => (a.projectName ?? "").localeCompare(b.projectName ?? "")
    || (a.invoiceNumber ?? "").localeCompare(b.invoiceNumber ?? ""));
  return rows;
}

router.get("/api/admin/invoice-rematch/preview", requireAuth, async (_req, res) => {
  try {
    const rows = await computePreview();
    res.json({ rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Preview failed: ${message}` });
  }
});

const applyBodySchema = z.object({
  invoiceIds: z.array(z.coerce.number().int().positive()).min(1),
}).strict();

router.post(
  "/api/admin/invoice-rematch/apply",
  requireAuth,
  validateRequest({ body: applyBodySchema }),
  async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const user = await storage.getUser(Number(userId));
    if (!user) return res.status(401).json({ message: "Authentication required" });

    const { invoiceIds } = req.body as z.infer<typeof applyBodySchema>;
    const idSet = Array.from(new Set<number>(invoiceIds));

    const [projects, contractors] = await Promise.all([
      storage.getProjects({ includeArchived: true }),
      storage.getContractors(),
    ]);
    const projectById = new Map<number, Project>(projects.map((p) => [p.id, p]));
    const contractorById = new Map<number, Contractor>(contractors.map((c) => [c.id, c]));

    const applied: Array<{ invoiceId: number; previousContractorId: number; newContractorId: number }> = [];
    const skipped: Array<{ invoiceId: number; reason: string }> = [];

    for (const invoiceId of idSet) {
      const invoice = await storage.getInvoice(invoiceId);
      if (!invoice) {
        skipped.push({ invoiceId, reason: "Invoice not found" });
        continue;
      }
      const aiData = invoice.aiExtractedData as ParsedDocument | null;
      if (!aiData || typeof aiData !== "object") {
        skipped.push({ invoiceId, reason: "No stored extraction data" });
        continue;
      }
      const match = await matchToProject(aiData, projects, contractors);
      if (match.contractorId == null) {
        skipped.push({ invoiceId, reason: "Re-match returned no contractor" });
        continue;
      }
      if (match.contractorId === invoice.contractorId) {
        skipped.push({ invoiceId, reason: "Contractor already correct" });
        continue;
      }
      if (invoice.status === "void") {
        skipped.push({ invoiceId, reason: "Invoice is void" });
        continue;
      }
      const project = projectById.get(invoice.projectId);
      if (project?.archivedAt) {
        skipped.push({ invoiceId, reason: "Project is archived" });
        continue;
      }
      const target = contractorById.get(match.contractorId);
      if (!target) {
        skipped.push({ invoiceId, reason: "Suggested contractor not found" });
        continue;
      }
      if (target.archidocOrphanedAt) {
        skipped.push({ invoiceId, reason: "Suggested contractor was removed from ArchiDoc" });
        continue;
      }

      const previousContractorId = invoice.contractorId;
      const previousContractor = contractorById.get(previousContractorId) ?? null;
      const updated = await storage.updateInvoice(invoiceId, { contractorId: target.id });
      if (!updated) {
        skipped.push({ invoiceId, reason: "Update failed" });
        continue;
      }
      await storage.createInvoiceRefEdit({
        invoiceId,
        field: "contractorId",
        previousValue: `${previousContractorId}:${previousContractor?.name ?? `#${previousContractorId}`}`,
        newValue: `${target.id}:${target.name}`,
        editedByUserId: user.id,
        editedByEmail: user.email,
      });
      applied.push({ invoiceId, previousContractorId, newContractorId: target.id });
    }

    res.json({ applied, skipped });
  },
);

export default router;
