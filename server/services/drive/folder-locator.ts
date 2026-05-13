/**
 * Walks the shared Drive to locate a project's root "1 DEVIS & FACTURE
 * FOLDERS" subfolder, given a project name.
 *
 * Path layout (Renosud convention, Task #198):
 *   {client folder = project name}
 *     └── FINANCIAL
 *         └── LIVE PROJECT FINANCIAL
 *             └── 1 DEVIS & FACTURE FOLDERS    ← what we cache
 *
 * Matching is case + accent + punctuation tolerant on the project name
 * (the architect's typed project name in Architrak rarely matches the
 * folder name byte-for-byte). The intermediate folder names are
 * matched exactly because they are a fixed Renosud convention.
 *
 * Result is cached on `projects.drive_folder_id` by the caller — this
 * module is pure lookup.
 */

import type { drive_v3 } from "googleapis";
import { getDriveConfig } from "./client";

const FINANCIAL_FOLDER_NAME = "FINANCIAL";
const LIVE_PROJECT_FINANCIAL_NAME = "LIVE PROJECT FINANCIAL";
const DEVIS_FACTURE_FOLDER_NAME = "1 DEVIS & FACTURE FOLDERS";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Strip diacritics, collapse whitespace, lowercase. Used to fuzz-match
 * project names against Drive folder names regardless of accents or
 * trailing/leading punctuation.
 */
export function normaliseFolderName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

interface ListResult {
  id: string;
  name: string;
}

async function listChildFolders(
  client: drive_v3.Drive,
  sharedDriveId: string,
  parentFolderId: string,
): Promise<ListResult[]> {
  const out: ListResult[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.files.list({
      q: `'${parentFolderId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 200,
      corpora: "drive",
      driveId: sharedDriveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

function findExactChild(folders: ListResult[], target: string): string | null {
  const targetNorm = normaliseFolderName(target);
  // Prefer literal match first to avoid matching e.g. "FINANCIAL OLD"
  // when there's an exact "FINANCIAL".
  const literal = folders.find((f) => f.name === target);
  if (literal) return literal.id;
  const fuzzy = folders.find((f) => normaliseFolderName(f.name) === targetNorm);
  return fuzzy ? fuzzy.id : null;
}

function findFuzzyProjectFolder(folders: ListResult[], projectName: string): string | null {
  const targetNorm = normaliseFolderName(projectName);
  if (!targetNorm) return null;
  // Strict policy (architect review of Task #198): only accept a
  // unique exact-normalised match. Any ambiguity → bail and force the
  // operator to disambiguate via the admin DLQ. We deliberately do
  // NOT fall back to "startsWith" or "includes" — first-match scans
  // can route doc copies into the wrong client folder when two
  // projects share a prefix (e.g. "Smith House" vs "Smith House Pool").
  const matches = folders.filter((f) => normaliseFolderName(f.name) === targetNorm);
  if (matches.length === 1) return matches[0].id;
  return null;
}

export class DriveFolderNotFoundError extends Error {
  // Stable name so isTransientDriveError can detect us without an
  // import cycle (client.ts must not import folder-locator.ts).
  override name = "DriveFolderNotFoundError";
  constructor(message: string) {
    super(message);
    this.name = "DriveFolderNotFoundError";
  }
}

/**
 * Locate (without creating) the project's `1 DEVIS & FACTURE FOLDERS`
 * folder id. Throws DriveFolderNotFoundError if any segment is missing
 * — we deliberately do NOT auto-create the upper segments because
 * those reflect the human Renosud filing structure and a typo would
 * pollute the shared drive.
 */
export async function locateProjectDevisRootFolder(
  projectName: string,
): Promise<string> {
  const cfg = getDriveConfig();
  if (!cfg) throw new Error("Drive auto-upload not configured");

  // Step 1 — list top-level folders of the shared drive.
  const topFolders = await listChildFolders(cfg.client, cfg.sharedDriveId, cfg.sharedDriveId);
  const targetNorm = normaliseFolderName(projectName);
  const candidates = topFolders.filter((f) => normaliseFolderName(f.name) === targetNorm);
  if (candidates.length > 1) {
    throw new DriveFolderNotFoundError(
      `Ambiguous: ${candidates.length} top-level folders match "${projectName}" — rename or remove duplicates and click Retry.`,
    );
  }
  const projectFolderId = findFuzzyProjectFolder(topFolders, projectName);
  if (!projectFolderId) {
    throw new DriveFolderNotFoundError(
      `No top-level folder on the shared drive exactly matches project "${projectName}" (case/accent-insensitive). Create or rename the client folder, then click Retry.`,
    );
  }

  // Step 2 — FINANCIAL.
  const projChildren = await listChildFolders(cfg.client, cfg.sharedDriveId, projectFolderId);
  const financialId = findExactChild(projChildren, FINANCIAL_FOLDER_NAME);
  if (!financialId) {
    throw new DriveFolderNotFoundError(
      `Project folder for "${projectName}" is missing a FINANCIAL subfolder.`,
    );
  }

  // Step 3 — LIVE PROJECT FINANCIAL.
  const finChildren = await listChildFolders(cfg.client, cfg.sharedDriveId, financialId);
  const liveId = findExactChild(finChildren, LIVE_PROJECT_FINANCIAL_NAME);
  if (!liveId) {
    throw new DriveFolderNotFoundError(
      `Project "${projectName}" is missing FINANCIAL/LIVE PROJECT FINANCIAL.`,
    );
  }

  // Step 4 — 1 DEVIS & FACTURE FOLDERS.
  const liveChildren = await listChildFolders(cfg.client, cfg.sharedDriveId, liveId);
  const devisRootId = findExactChild(liveChildren, DEVIS_FACTURE_FOLDER_NAME);
  if (!devisRootId) {
    throw new DriveFolderNotFoundError(
      `Project "${projectName}" is missing FINANCIAL/LIVE PROJECT FINANCIAL/${DEVIS_FACTURE_FOLDER_NAME}.`,
    );
  }
  return devisRootId;
}

/**
 * Find an existing child folder by exact name; returns null if absent.
 * Used by ensureLotFolder to make folder creation idempotent.
 */
export async function findChildFolderByName(
  parentFolderId: string,
  name: string,
): Promise<string | null> {
  const cfg = getDriveConfig();
  if (!cfg) throw new Error("Drive auto-upload not configured");
  const folders = await listChildFolders(cfg.client, cfg.sharedDriveId, parentFolderId);
  return findExactChild(folders, name);
}

/** Create a child folder (used when ensureLotFolder needs to make one). */
export async function createChildFolder(
  parentFolderId: string,
  name: string,
): Promise<string> {
  const cfg = getDriveConfig();
  if (!cfg) throw new Error("Drive auto-upload not configured");
  const res = await cfg.client.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentFolderId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  if (!res.data.id) throw new Error(`Drive returned no id when creating folder "${name}"`);
  return res.data.id;
}
