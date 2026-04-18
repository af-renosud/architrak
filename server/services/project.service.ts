import { db } from "../db";
import { sql } from "drizzle-orm";
import { invoices, situations, certificats, devis, projects } from "@shared/schema";
import { eq } from "drizzle-orm";

export interface RetainedRecordCounts {
  invoices: number;
  situations: number;
  certificats: number;
}

export class ProjectRetentionError extends Error {
  readonly code = "PROJECT_RETENTION_BLOCKED";
  readonly retained: RetainedRecordCounts;
  constructor(retained: RetainedRecordCounts) {
    const parts: string[] = [];
    if (retained.invoices > 0) parts.push(`${retained.invoices} invoice(s)`);
    if (retained.situations > 0) parts.push(`${retained.situations} situation(s)`);
    if (retained.certificats > 0) parts.push(`${retained.certificats} certificat(s)`);
    super(
      "Cannot delete project: French law (Code de commerce L123-22) requires accounting records " +
        "to be retained for 10 years. This project still has " +
        parts.join(", ") +
        " on file. Archive or transfer these records before deletion."
    );
    this.name = "ProjectRetentionError";
    this.retained = retained;
  }
}

export class ProjectNotFoundError extends Error {
  readonly code = "PROJECT_NOT_FOUND";
  constructor(projectId: number) {
    super(`Project ${projectId} not found`);
    this.name = "ProjectNotFoundError";
  }
}

/**
 * Pluggable executor used by `deleteProjectWithRetentionCheck` so the
 * retention logic can be unit-tested without a live database.
 */
export interface ProjectDeletionExecutor {
  projectExists(projectId: number): Promise<boolean>;
  /**
   * Locks every container row that holds (or could hold) a retained
   * financial record for this project, so concurrent inserts cannot slip
   * a record in between the count and the delete. Concretely this means
   * locking every `devis` row for the project (situations FK to devis,
   * not to projects), in addition to the project row itself which has
   * already been locked by `projectExists`.
   */
  lockChildContainers(projectId: number): Promise<void>;
  countInvoices(projectId: number): Promise<number>;
  countSituations(projectId: number): Promise<number>;
  countCertificats(projectId: number): Promise<number>;
  deleteProject(projectId: number): Promise<void>;
}

/**
 * Pure orchestration: counts retained records and either throws or deletes.
 * The caller is responsible for binding `exec` to a transaction so the
 * count + delete happen atomically (no TOCTOU window).
 */
export async function deleteProjectWithRetentionCheck(
  projectId: number,
  exec: ProjectDeletionExecutor
): Promise<void> {
  const exists = await exec.projectExists(projectId);
  if (!exists) throw new ProjectNotFoundError(projectId);

  // Lock every devis row for the project so a concurrent transaction
  // cannot insert a `situations` row referencing one of those devis
  // between our count and our delete. (`situations` FK to `devis`, not
  // to `projects`, so locking the projects row alone is not enough.)
  await exec.lockChildContainers(projectId);

  const [invoiceCount, situationCount, certificatCount] = await Promise.all([
    exec.countInvoices(projectId),
    exec.countSituations(projectId),
    exec.countCertificats(projectId),
  ]);

  if (invoiceCount > 0 || situationCount > 0 || certificatCount > 0) {
    throw new ProjectRetentionError({
      invoices: invoiceCount,
      situations: situationCount,
      certificats: certificatCount,
    });
  }

  await exec.deleteProject(projectId);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function makeTxExecutor(tx: Tx): ProjectDeletionExecutor {
  return {
    async projectExists(projectId) {
      // Lock the project row for the lifetime of this transaction so any
      // concurrent transaction that tries to insert a financial record
      // that FKs directly to projects (invoices, certificats, devis) is
      // forced to wait on the FK key-share lock until our transaction
      // commits or rolls back.
      const rows = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
        .for("update");
      return rows.length > 0;
    },
    async lockChildContainers(projectId) {
      // situations FK to devis (not directly to projects), so a project
      // row lock alone is not enough — a concurrent tx could still
      // insert a situation against an existing devis. Lock every devis
      // row for the project so any insert into situations referencing
      // those devis is blocked until we commit/rollback.
      await tx
        .select({ id: devis.id })
        .from(devis)
        .where(eq(devis.projectId, projectId))
        .for("update");
    },
    async countInvoices(projectId) {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(invoices)
        .where(eq(invoices.projectId, projectId));
      return row?.n ?? 0;
    },
    async countSituations(projectId) {
      // situations are linked to a project transitively via devis
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(situations)
        .innerJoin(devis, eq(situations.devisId, devis.id))
        .where(eq(devis.projectId, projectId));
      return row?.n ?? 0;
    },
    async countCertificats(projectId) {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(certificats)
        .where(eq(certificats.projectId, projectId));
      return row?.n ?? 0;
    },
    async deleteProject(projectId) {
      await tx.delete(projects).where(eq(projects.id, projectId));
    },
  };
}

/**
 * Delete a project, refusing if any retained financial records remain.
 * The retention check and the delete run in the same transaction so a
 * concurrent insert cannot slip past the guard.
 */
export async function deleteProject(projectId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteProjectWithRetentionCheck(projectId, makeTxExecutor(tx));
  });
}
