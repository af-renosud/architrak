/**
 * Drive auto-upload queue + retry orchestrator (Task #198, AT5-style).
 *
 * - `enqueueDriveUpload(...)` is the only entry point callers use.
 *   Idempotent on (docKind, docId) thanks to the SQL UNIQUE constraint:
 *   re-enqueuing an already-succeeded row is a no-op.
 * - First attempt is dispatched inline as a fire-and-forget so an
 *   operator clicking "upload devis" sees the View-on-Drive button
 *   appear within seconds in the typical case.
 * - A process-local sweeper (setInterval, 60s) reattempts pending rows
 *   whose `nextAttemptAt` has passed, so transient Drive 5xx / network
 *   blips self-heal without operator action.
 * - 5 attempts total → dead_letter, surfaced on the admin DLQ at
 *   /admin/ops/drive-uploads.
 *
 * The whole module short-circuits when the feature flag is off (or
 * the credentials/shared-drive-id env vars are missing) — enqueue
 * silently no-ops so wire-in callers don't have to know.
 */

import type { DriveUpload, DriveUploadDocKind } from "@shared/schema";
import { storage } from "../../storage";
import { isDriveAutoUploadEnabled, isTransientDriveError } from "./client";
import { ensureLotFolder } from "./lot-folder.service";
import { uploadPdfToFolder } from "./upload.service";

export const MAX_DRIVE_UPLOAD_ATTEMPTS = 5;

/**
 * Internal separator used to piggy-back the seed devis code onto the
 * `display_name` column without needing a fresh migration. Chosen
 * because Drive file names should never legitimately contain `\u0001`.
 */
const SEED_SEP = "\u0001";

function decodeDisplayName(stored: string): { displayName: string; seedDevisCode: string | null } {
  const idx = stored.indexOf(SEED_SEP);
  if (idx < 0) return { displayName: stored, seedDevisCode: null };
  return {
    displayName: stored.slice(0, idx),
    seedDevisCode: stored.slice(idx + 1) || null,
  };
}

// Backoff schedule between attempts (ms). Index = attempt number that
// just failed (1..4). Doubles roughly each step, capped at 5 minutes.
const BACKOFF_MS: readonly number[] = [
  10_000,   // after attempt 1 → wait 10s
  30_000,   // after attempt 2 → wait 30s
  120_000,  // after attempt 3 → wait 2m
  300_000,  // after attempt 4 → wait 5m
];

let sweeperInterval: ReturnType<typeof setInterval> | null = null;

export interface EnqueueInput {
  docKind: DriveUploadDocKind;
  docId: number;
  projectId: number;
  lotId: number | null;
  sourceStorageKey: string;
  /** Human-friendly file name shown in Drive (e.g. "DEV-2025-001.pdf"). */
  displayName: string;
  /**
   * The devis code that should seed the per-lot folder name when this
   * doc lands first on a lot that has no Drive folder yet. ONE LOT =
   * ONE FOLDER means the seed must be a stable devis identifier even
   * for invoice/certificat enqueues, because Drive folder name is
   * `{Lot} {project} {devisCode}`. Optional: defaults to the
   * displayName stem (correct for devis enqueues; callers MUST pass
   * an explicit value for invoices and certificats).
   */
  seedDevisCode?: string;
}

/**
 * Idempotent enqueue. Safe to call from any wire-in point even when
 * the feature is disabled — no-ops in that case so callers never have
 * to gate themselves.
 */
export async function enqueueDriveUpload(input: EnqueueInput): Promise<void> {
  if (!isDriveAutoUploadEnabled()) return;
  try {
    // Encode the seed devis code into the displayName via a separator
    // the path-safe sanitiser strips back out, so we don't have to
    // ship a schema migration just to thread one extra field. Decoded
    // in `attemptDriveUpload` via SEED_SEP. The visible Drive file
    // name is unchanged (`safeNamePart` already drops `|`).
    const encodedDisplayName = input.seedDevisCode
      ? `${input.displayName}${SEED_SEP}${input.seedDevisCode}`
      : input.displayName;
    const row = await storage.upsertDriveUpload({
      docKind: input.docKind,
      docId: input.docId,
      projectId: input.projectId,
      lotId: input.lotId,
      sourceStorageKey: input.sourceStorageKey,
      displayName: encodedDisplayName,
      state: "pending",
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      nextAttemptAt: new Date(),
      driveFileId: null,
      driveWebViewLink: null,
    });
    // Only attempt inline if this is the first time we've seen this
    // doc — re-enqueue of a succeeded/dead-lettered row hits the
    // sweeper through the admin retry button, not here.
    if (row.state === "pending" && row.attempts === 0) {
      attemptDriveUpload(row.id).catch((err) => {
        console.error(`[DriveQueue] inline first attempt for upload ${row.id} crashed:`, err);
      });
    }
  } catch (err) {
    console.error(`[DriveQueue] enqueue failed for ${input.docKind}#${input.docId}:`, err);
  }
}

/**
 * Best-effort single attempt. Updates the row state in place. Safe
 * to call concurrently — the SQL UPDATE is the locking primitive.
 */
export async function attemptDriveUpload(uploadId: number): Promise<void> {
  if (!isDriveAutoUploadEnabled()) return;

  const claimed = await storage.claimDriveUploadForAttempt(uploadId);
  if (!claimed) return; // someone else grabbed it / already done

  const row = claimed;
  const attemptNum = row.attempts + 1;
  const { displayName, seedDevisCode } = decodeDisplayName(row.displayName);
  try {
    const folderId = await ensureLotFolder({
      projectId: row.projectId,
      lotId: row.lotId,
      seedDevisCode: (seedDevisCode ?? displayName).replace(/\.pdf$/i, ""),
    });
    const result = await uploadPdfToFolder(folderId, displayName, row.sourceStorageKey);

    await storage.markDriveUploadSucceeded({
      uploadId: row.id,
      attempts: attemptNum,
      driveFileId: result.fileId,
      driveWebViewLink: result.webViewLink,
    });
    await writeBackToSourceRow(row.docKind as DriveUploadDocKind, row.docId, result);
  } catch (err) {
    const transient = isTransientDriveError(err);
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = attemptNum >= MAX_DRIVE_UPLOAD_ATTEMPTS;
    if (!transient || exhausted) {
      await storage.markDriveUploadDeadLettered({
        uploadId: row.id,
        attempts: attemptNum,
        lastError: message.slice(0, 1000),
      });
      console.warn(
        `[DriveQueue] upload ${row.id} (${row.docKind}#${row.docId}) ${exhausted ? "exhausted" : "permanent failure"}: ${message}`,
      );
      return;
    }
    const wait = BACKOFF_MS[Math.min(attemptNum - 1, BACKOFF_MS.length - 1)];
    await storage.markDriveUploadPendingRetry({
      uploadId: row.id,
      attempts: attemptNum,
      lastError: message.slice(0, 1000),
      nextAttemptAt: new Date(Date.now() + wait),
    });
    console.warn(
      `[DriveQueue] upload ${row.id} transient failure on attempt ${attemptNum}, retry in ${Math.round(wait / 1000)}s: ${message}`,
    );
  }
}

async function writeBackToSourceRow(
  docKind: DriveUploadDocKind,
  docId: number,
  result: { fileId: string; webViewLink: string },
): Promise<void> {
  switch (docKind) {
    case "devis":
      await storage.setDevisDriveLink(docId, result.fileId, result.webViewLink);
      return;
    case "invoice":
      await storage.setInvoiceDriveLink(docId, result.fileId, result.webViewLink);
      return;
    case "certificat":
      await storage.setCertificatDriveLink(docId, result.fileId, result.webViewLink);
      return;
    default: {
      // Compile-time exhaustiveness so adding a new DriveUploadDocKind
      // forces us to add a writeback path.
      const _never: never = docKind;
      throw new Error(`Unknown drive doc kind: ${String(_never)}`);
    }
  }
}

/**
 * Lease window for an `in_flight` claim. If a worker crashes between
 * claim and finish, the row would otherwise stick in `in_flight`
 * forever (sweeper only scans `pending`). We reclaim any in_flight
 * row whose `lastAttemptAt` is older than this. 10 minutes is well
 * above any realistic upload time (PDFs are <25 MiB).
 */
export const STALE_IN_FLIGHT_RECLAIM_MS = 10 * 60 * 1000;

/** Sweep all `pending` rows whose nextAttemptAt has elapsed. */
export async function sweepPendingDriveUploads(): Promise<void> {
  if (!isDriveAutoUploadEnabled()) return;
  try {
    // Reclaim crashed in_flight rows BEFORE listing due — so reclaimed
    // rows are picked up in this same tick.
    const reclaimed = await storage.reclaimStaleDriveUploads(STALE_IN_FLIGHT_RECLAIM_MS);
    if (reclaimed > 0) {
      console.warn(`[DriveQueue] reclaimed ${reclaimed} stale in_flight upload(s)`);
    }
    const due = await storage.listDueDriveUploads(20);
    for (const row of due) {
      await attemptDriveUpload(row.id).catch((err) => {
        console.error(`[DriveQueue] sweep attempt for ${row.id} crashed:`, err);
      });
    }
  } catch (err) {
    console.error("[DriveQueue] sweep failed:", err);
  }
}

export function startDriveUploadSweeper(intervalMs: number = 60_000): void {
  if (sweeperInterval) return;
  if (!isDriveAutoUploadEnabled()) {
    console.log("[DriveQueue] sweeper not started — feature disabled");
    return;
  }
  sweeperInterval = setInterval(() => {
    sweepPendingDriveUploads().catch(console.error);
  }, intervalMs);
  console.log(`[DriveQueue] sweeper started (every ${Math.round(intervalMs / 1000)}s)`);
}

export function stopDriveUploadSweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}

export type { DriveUpload };
