import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  intakeProjectIdentityResolutions,
  projectIntakeDocuments,
  projects,
} from "@shared/schema";
import { resolveLabelledProjectIdentity, type ParsedDocument } from "../../gmail/document-parser";

export type ConfirmIntakeProjectIdentityResult =
  | { outcome: "ok"; replayed: boolean; projectId: number }
  | { outcome: "not_found" }
  | { outcome: "invalid"; code: string; message: string };

export async function getConfirmedIntakeProjectIdentity(
  intakeDocumentId: number,
  sourceContentFingerprint: string,
): Promise<{ projectId: number } | null> {
  const [resolution] = await db
    .select({ projectId: intakeProjectIdentityResolutions.projectId })
    .from(intakeProjectIdentityResolutions)
    .where(and(
      eq(intakeProjectIdentityResolutions.intakeDocumentId, intakeDocumentId),
      eq(intakeProjectIdentityResolutions.sourceContentFingerprint, sourceContentFingerprint),
    ))
    .limit(1);
  return resolution ?? null;
}

export async function confirmIntakeProjectIdentity(input: {
  intakeDocumentId: number;
  expectedFingerprint: string;
  confirmedByUserId: number;
}): Promise<ConfirmIntakeProjectIdentityResult> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(projectIntakeDocuments)
      .where(eq(projectIntakeDocuments.id, input.intakeDocumentId))
      .for("update");
    if (!doc) return { outcome: "not_found" as const };

    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, doc.projectId))
      .for("update");
    if (!project || project.archivedAt != null) {
      return {
        outcome: "invalid" as const,
        code: "project_archived",
        message: "Archived projects are read-only.",
      };
    }
    if (!doc.contentFingerprint || doc.contentFingerprint !== input.expectedFingerprint) {
      return {
        outcome: "invalid" as const,
        code: "stale_source_fingerprint",
        message: "The source document changed after review. Re-analyze it before confirming the project.",
      };
    }

    const [existing] = await tx
      .select()
      .from(intakeProjectIdentityResolutions)
      .where(and(
        eq(intakeProjectIdentityResolutions.intakeDocumentId, doc.id),
        eq(intakeProjectIdentityResolutions.sourceContentFingerprint, doc.contentFingerprint),
      ))
      .for("update");
    if (existing) {
      if (existing.projectId !== doc.projectId) {
        return {
          outcome: "invalid" as const,
          code: "project_resolution_conflict",
          message: "This source was already confirmed for a different project.",
        };
      }
      return { outcome: "ok" as const, replayed: true, projectId: existing.projectId };
    }

    if (
      doc.analysisState !== "analyzed"
      || doc.routingState !== "parked"
      || doc.promotedId != null
    ) {
      return {
        outcome: "invalid" as const,
        code: "project_resolution_invalid_state",
        message: "Only an analyzed, parked, unpromoted document can have its project confirmed.",
      };
    }

    const parsed = (doc.extractedData ?? {}) as ParsedDocument;
    if (!parsed.projectName?.trim() && !parsed.projectReference?.trim()) {
      return {
        outcome: "invalid" as const,
        code: "project_resolution_no_label",
        message: "The document contains no labelled project identity to resolve.",
      };
    }
    const allProjects = await tx.select().from(projects);
    const automatic = resolveLabelledProjectIdentity(parsed, allProjects);
    if (automatic.kind === "matched") {
      if (automatic.project.id !== doc.projectId) {
        return {
          outcome: "invalid" as const,
          code: "project_resolution_wrong_project",
          message: "The labelled identity exactly matches a different live project and cannot be overridden.",
        };
      }
      return {
        outcome: "invalid" as const,
        code: "project_resolution_not_needed",
        message: "The labelled project identity already matches this project.",
      };
    }

    await tx.insert(intakeProjectIdentityResolutions).values({
      intakeDocumentId: doc.id,
      projectId: doc.projectId,
      sourceStorageKey: doc.storageKey,
      sourceFileName: doc.fileName,
      sourceContentFingerprint: doc.contentFingerprint,
      labelledProjectName: parsed.projectName?.trim() || null,
      labelledProjectReference: parsed.projectReference?.trim() || null,
      confirmedByUserId: input.confirmedByUserId,
    });
    return { outcome: "ok" as const, replayed: false, projectId: doc.projectId };
  });
}