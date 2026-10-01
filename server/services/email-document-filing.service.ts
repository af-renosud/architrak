import { eq, inArray } from "drizzle-orm";
import {
  devis,
  invoices,
  marcheDocuments,
  projectIntakeDocuments,
  projects,
  situations,
  type EmailDocument,
} from "@shared/schema";
import {
  classifyEmailDocumentFiling,
  type EmailDocumentWithFiling,
  type FilingIntakeSource,
  type FilingTarget,
} from "@shared/email-document-filing";
import { db } from "../db";

export interface EmailDocumentFilingLookups {
  intakes: readonly FilingIntakeSource[];
  projectIds: ReadonlySet<number>;
  targets: readonly FilingTarget[];
}

/** Apply already-batched lookup fixtures or DB results without any writes. */
export function enrichEmailDocumentsFromLookups(
  documents: readonly EmailDocument[],
  lookups: EmailDocumentFilingLookups,
): EmailDocumentWithFiling[] {
  const intakesByEmail = new Map(lookups.intakes.map((intake) => [intake.sourceEmailDocumentId, intake]));
  const targetsByKey = new Map(lookups.targets.map((target) => [`${target.kind}:${target.id}`, target]));
  return documents.map((email) => {
    const intake = intakesByEmail.get(email.id) ?? null;
    const projectId = intake?.projectId ?? email.projectId;
    return {
      ...email,
      filing: classifyEmailDocumentFiling({
        email,
        intake,
        projectExists: projectId != null && lookups.projectIds.has(projectId),
        target: intake ? targetsByKey.get(`${intake.promotedKind}:${intake.promotedId}`) ?? null : null,
      }),
    };
  });
}

function isRemoved(status: string): boolean {
  return ["void", "removed", "deleted"].includes(status);
}

/**
 * One intake query, one project query and at most one query per promoted kind,
 * independent of the number of email rows. Only SELECTs: no mirroring,
 * reprocessing, assignment changes, provider calls or stale-pointer repair.
 */
export async function enrichEmailDocumentsWithFiling(
  documents: readonly EmailDocument[],
): Promise<EmailDocumentWithFiling[]> {
  if (documents.length === 0) return [];
  const intakes = await db.select({
    id: projectIntakeDocuments.id,
    projectId: projectIntakeDocuments.projectId,
    sourceEmailDocumentId: projectIntakeDocuments.sourceEmailDocumentId,
    analysisState: projectIntakeDocuments.analysisState,
    routingState: projectIntakeDocuments.routingState,
    promotedKind: projectIntakeDocuments.promotedKind,
    promotedId: projectIntakeDocuments.promotedId,
    notes: projectIntakeDocuments.notes,
  }).from(projectIntakeDocuments).where(inArray(projectIntakeDocuments.sourceEmailDocumentId, documents.map((doc) => doc.id)));

  const projectIds = Array.from(new Set([
    ...documents.map((doc) => doc.projectId),
    ...intakes.map((intake) => intake.projectId),
  ].filter((id): id is number => id != null)));
  function targetIds(kind: string): number[] {
    return Array.from(new Set(intakes
      .filter((intake) => intake.promotedKind === kind && intake.promotedId != null)
      .map((intake) => intake.promotedId!)));
  }
  const devisIds = targetIds("devis");
  const invoiceIds = targetIds("invoice");
  const situationIds = targetIds("situation");
  const marcheDocumentIds = targetIds("marche_document");

  const [liveProjects, devisTargets, invoiceTargets, situationTargets, marcheTargets] = await Promise.all([
    projectIds.length ? db.select({ id: projects.id }).from(projects).where(inArray(projects.id, projectIds)) : [],
    devisIds.length ? db.select({
      id: devis.id, projectId: devis.projectId, sourceIntakeDocumentId: devis.sourceIntakeDocumentId, status: devis.status,
    }).from(devis).where(inArray(devis.id, devisIds)) : [],
    invoiceIds.length ? db.select({
      id: invoices.id, projectId: invoices.projectId, sourceIntakeDocumentId: invoices.sourceIntakeDocumentId, status: invoices.status,
    }).from(invoices).where(inArray(invoices.id, invoiceIds)) : [],
    situationIds.length ? db.select({
      id: situations.id, projectId: devis.projectId, sourceIntakeDocumentId: situations.sourceIntakeDocumentId,
      status: situations.status, devisStatus: devis.status,
    }).from(situations).innerJoin(devis, eq(situations.devisId, devis.id)).where(inArray(situations.id, situationIds)) : [],
    marcheDocumentIds.length ? db.select({
      id: marcheDocuments.id, projectId: marcheDocuments.projectId,
      sourceIntakeDocumentId: marcheDocuments.sourceIntakeDocumentId, status: marcheDocuments.status,
    }).from(marcheDocuments).where(inArray(marcheDocuments.id, marcheDocumentIds)) : [],
  ]);
  const targets: FilingTarget[] = [
    ...devisTargets.map((row) => ({ ...row, kind: "devis", isRemoved: isRemoved(row.status) })),
    ...invoiceTargets.map((row) => ({ ...row, kind: "invoice", isRemoved: isRemoved(row.status) })),
    ...situationTargets.map((row) => ({
      ...row, kind: "situation", isRemoved: isRemoved(row.status) || isRemoved(row.devisStatus),
    })),
    ...marcheTargets.map((row) => ({ ...row, kind: "marche_document", isRemoved: isRemoved(row.status) })),
  ];
  return enrichEmailDocumentsFromLookups(documents, {
    intakes,
    projectIds: new Set(liveProjects.map((project) => project.id)),
    targets,
  });
}