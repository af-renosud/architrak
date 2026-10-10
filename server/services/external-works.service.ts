import { and, eq, desc, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { externalWorks, externalWorkAudit, projects, devis, certificats } from "@shared/schema";
import { externalWorkInput, normalizeExternalReference, type ExternalCostOverview, type ExternalCostRow } from "@shared/external-works";
import { z } from "zod";

export class ExternalWorksError extends Error {
  constructor(public status: number, public code: string, message: string, public overlaps?: { id: number; reference: string }[]) { super(message); }
}
export async function listExternalWorks(projectId: number) {
  return db.select().from(externalWorks).where(eq(externalWorks.projectId, projectId)).orderBy(externalWorks.id);
}
export async function externalWorksRegister(projectId: number) {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!project) throw new ExternalWorksError(404, "NOT_FOUND", "Project not found");
  const [entries, history] = await Promise.all([
    listExternalWorks(projectId),
    db.select().from(externalWorkAudit).where(eq(externalWorkAudit.projectId, projectId)).orderBy(desc(externalWorkAudit.id)),
  ]);
  return { entries, history };
}
export function buildExternalCostOverview(
  entries: Array<ExternalCostRow & { status: string }>, managedHt: number, managedTtc: number,
): ExternalCostOverview {
  const rows = entries.filter(r => r.status === "active").map(({ id, reference, description, companyName, lot, completionDate, amountHt, amountTtc }) =>
    ({ id, reference, description, companyName, lot, completionDate, amountHt, amountTtc }));
  const totalExternalHt = rows.reduce((n, r) => n + Math.round(Number(r.amountHt) * 100), 0) / 100;
  const totalExternalTtc = rows.reduce((n, r) => n + Math.round(Number(r.amountTtc) * 100), 0) / 100;
  return { entries: rows, totalExternalHt, totalExternalTtc,
    totalCombinedCostHt: (Math.round(managedHt * 100) + Math.round(totalExternalHt * 100)) / 100,
    totalCombinedCostTtc: (Math.round(managedTtc * 100) + Math.round(totalExternalTtc * 100)) / 100 };
}
const lifecycleInput = z.object({ version: z.number().int().positive(), reason: z.string().trim().min(1).max(1000).optional(), acknowledgeOverlap: z.boolean().optional() }).strict();
export async function mutateExternalWork(projectId: number, id: number | null, action: "create" | "edit" | "void" | "restore", raw: unknown, actor: { id: number; name: string }) {
  const input = action === "create" || action === "edit" ? externalWorkInput.parse(raw) : lifecycleInput.parse(raw);
  if (action !== "create" && !input.version) throw new ExternalWorksError(400, "VERSION_REQUIRED", "Reload the entry before changing it");
  if (action === "void" && !("reason" in input && input.reason)) throw new ExternalWorksError(400, "REASON_REQUIRED", "A void reason is required");
  return db.transaction(async tx => {
    // Shared order with issuance: project first, then certificate rows. Edits
    // bump unsealed versions so a render using older register data cannot seal.
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw new ExternalWorksError(404, "NOT_FOUND", "Project not found");
    if (project.archivedAt || project.status === "archived") throw new ExternalWorksError(409, "PROJECT_ARCHIVED", "Archived projects are read-only");
    const [before] = id ? await tx.select().from(externalWorks).where(and(eq(externalWorks.id, id), eq(externalWorks.projectId, projectId))).for("update") : [];
    if (id && !before) throw new ExternalWorksError(404, "NOT_FOUND", "Entry not found");
    if (before && before.version !== input.version) throw new ExternalWorksError(409, "VERSION_CONFLICT", "This entry changed. Reload it before saving; your unsaved values have not been applied.");
    if (before && ((action === "restore") !== (before.status === "void"))) throw new ExternalWorksError(409, "STATE_CONFLICT", "This action is not available in the entry's current state");
    const reference = "reference" in input ? input.reference : before!.reference;
    const normalizedReference = normalizeExternalReference(reference);
    const siblings = await tx.select().from(externalWorks).where(eq(externalWorks.projectId, projectId));
    if (siblings.some(r => r.id !== id && r.normalizedReference === normalizedReference)) throw new ExternalWorksError(409, "DUPLICATE_REFERENCE", "This external reference already exists, including void entries. Edit or restore that entry.");
    let overlaps: { id: number; reference: string }[] = [];
    if (action !== "void") {
      const managed = await tx.select().from(devis).where(eq(devis.projectId, projectId));
      overlaps = managed.filter(d => d.status !== "void" && [d.devisCode, d.devisNumber, d.ref2].some(v => v && normalizeExternalReference(v) === normalizedReference)).map(d => ({ id: d.id, reference: d.devisCode }));
      if (overlaps.length && !input.acknowledgeOverlap) throw new ExternalWorksError(409, "MANAGED_OVERLAP", "A managed Devis uses this reference. Confirm this entry covers different works to avoid counting the same scope twice.", overlaps);
    }
    const values = "reference" in input ? {
      reference, normalizedReference, description: input.description, amountHt: input.amountHt, amountTtc: input.amountTtc,
      companyName: input.companyName, lot: input.lot, completionDate: input.completionDate,
    } : {};
    const reason = "reason" in input ? input.reason ?? null : null;
    const [after] = action === "create"
      ? await tx.insert(externalWorks).values({ ...values, projectId } as typeof externalWorks.$inferInsert).returning()
      : await tx.update(externalWorks).set({ ...values, status: action === "void" ? "void" : "active",
          voidReason: action === "void" ? reason : null, version: before!.version + 1, updatedAt: new Date() })
        .where(and(eq(externalWorks.id, id!), eq(externalWorks.version, input.version!))).returning();
    await tx.insert(externalWorkAudit).values({
      entryId: after.id, projectId, action, actorId: actor.id, actorName: actor.name,
      before: before ?? null, after: { ...after, confirmedCompleted: true, acknowledgedOverlaps: input.acknowledgeOverlap ? overlaps : [] }, reason,
    });
    await tx.update(certificats).set({ version: sql`${certificats.version} + 1` })
      .where(and(eq(certificats.projectId, projectId), isNull(certificats.pdfStorageKey)));
    return after;
  });
}
