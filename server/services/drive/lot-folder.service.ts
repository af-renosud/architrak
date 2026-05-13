/**
 * Per-lot Drive folder resolver (Task #198).
 *
 * Returns the Drive folder id for `{Lot} {project_name} {devisCode}`
 * under the project's "1 DEVIS & FACTURE FOLDERS" root, creating any
 * missing levels along the way:
 *
 *   project root (cached on `projects.drive_folder_id`)
 *     └── {Lot N} {project name} {first devisCode}     ← cached on
 *                                                        `lots.drive_folder_id`
 *
 * Important contract: ONE LOT → ONE FOLDER. The folder name is
 * stamped at first creation using the triggering devis's code (so
 * future avenants / PV-MV / factures / certificats land alongside
 * the original devis). If the cached id refers to a folder that has
 * been moved / renamed in Drive, we trust the id and do NOT rename
 * the folder back — the operator may have intentionally renamed it.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import {
  createChildFolder,
  findChildFolderByName,
  locateProjectDevisRootFolder,
} from "./folder-locator";

/**
 * Postgres advisory lock keyed by (namespace, lotId) — namespace 198
 * is reserved for Task #198's per-lot folder creation. Serialises
 * concurrent `ensureLotFolder` calls for the same lot so two workers
 * can't both miss the cached id and create duplicate Drive folders
 * before either has persisted `lots.drive_folder_id`. Released by the
 * normal end-of-statement flow on the connection — we use the
 * transactional variant so the release is automatic + scoped.
 */
async function withLotAdvisoryLock<T>(lotKey: number, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(198, ${lotKey})`);
    return fn();
  });
}

/**
 * Sanitise a string for use as a Drive folder/file name. Drive itself
 * tolerates almost everything except the slash, but for human
 * readability we collapse whitespace and strip control characters.
 */
function safeNamePart(s: string): string {
  return s.replace(/[\\/]+/g, "-").replace(/\s+/g, " ").trim();
}

export function buildLotFolderName(
  lotNumber: string,
  projectName: string,
  devisCode: string,
): string {
  // Format chosen to read naturally in Drive's tree view:
  //   "Lot 7 - Smith House DEV-2025-001"
  // with the Lot prefix only added when not already present.
  const lotPart = /^lot\b/i.test(lotNumber.trim())
    ? safeNamePart(lotNumber)
    : `Lot ${safeNamePart(lotNumber)}`;
  return `${lotPart} ${safeNamePart(projectName)} ${safeNamePart(devisCode)}`.trim();
}

export interface EnsureLotFolderInput {
  projectId: number;
  lotId: number | null;
  /** Used to seed the folder name when the lot has no Drive folder yet. */
  seedDevisCode: string;
}

/**
 * Resolves (and caches) the per-lot Drive folder. If `lotId` is null
 * — devis lot not yet assigned in Architrak — we fall back to
 * uploading directly into the project's `1 DEVIS & FACTURE FOLDERS`
 * root with `(unassigned-lot) {project} {devisCode}` as the
 * subfolder name, so the doc still lands somewhere recoverable.
 */
export async function ensureLotFolder(input: EnsureLotFolderInput): Promise<string> {
  const project = await storage.getProject(input.projectId);
  if (!project) throw new Error(`Project ${input.projectId} not found`);

  // 1. Project-level root (cache on projects.drive_folder_id).
  let projectRootId = project.driveFolderId;
  if (!projectRootId) {
    projectRootId = await locateProjectDevisRootFolder(project.name);
    await storage.setProjectDriveFolderId(input.projectId, projectRootId);
  }

  // 2. Per-lot folder. Namespace the unassigned-lot path under a
  // negative key so it can't collide with a real lot id.
  if (input.lotId == null) {
    return withLotAdvisoryLock(-input.projectId, async () => {
      const fallbackName = `(unassigned-lot) ${safeNamePart(project.name)} ${safeNamePart(input.seedDevisCode)}`;
      const existing = await findChildFolderByName(projectRootId!, fallbackName);
      if (existing) return existing;
      return createChildFolder(projectRootId!, fallbackName);
    });
  }

  const lotId = input.lotId;
  return withLotAdvisoryLock(lotId, async () => {
    // Re-read inside the lock — another worker may have just set the id.
    const lot = await storage.getLot(lotId);
    if (!lot) throw new Error(`Lot ${lotId} not found`);
    if (lot.driveFolderId) return lot.driveFolderId;

    const desiredName = buildLotFolderName(lot.lotNumber, project.name, input.seedDevisCode);
    const existing = await findChildFolderByName(projectRootId!, desiredName);
    const folderId = existing ?? (await createChildFolder(projectRootId!, desiredName));
    await storage.setLotDriveFolderId(lotId, folderId);
    return folderId;
  });
}
