/**
 * Task #206 — persist the signed devis PDF locally and mirror it to
 * the per-lot Drive folder.
 *
 * Called from the `envelope.signed` webhook handler AFTER the stage
 * transition has been persisted. Failure here MUST NOT roll back the
 * stage change — the architect-facing sign-off is authoritative even
 * if our own audit copy is temporarily unreachable. We log loudly so
 * the operator can pick up the failure from the workflow logs and
 * re-trigger via the admin DLQ once Archisign is healthy again.
 *
 * Idempotent: if `signedPdfStorageKey` is already set, we no-op the
 * download but still ensure a Drive enqueue exists (the upsert in
 * `enqueueDriveUpload` is itself idempotent on (docKind, docId)).
 *
 * Download strategy:
 *   1. Try the snapshot URL delivered with the webhook (~15min TTL,
 *      almost always live since webhooks fire within seconds).
 *   2. Fall back to re-minting via `getSignedPdfUrl` when the snapshot
 *      fails for any reason (expired, network, 5xx).
 *   3. On `ArchisignRetentionBreachError` — Archisign has already
 *      purged the bytes — log + give up; the audit copy is no longer
 *      retrievable from the source of truth.
 */

import { storage } from "../storage";
import {
  getSignedPdfUrl,
  ArchisignRetentionBreachError,
} from "./archisign.js";
import { uploadDocumentAtKey, buildSignedDevisObjectName } from "../storage/object-storage";
import { enqueueDriveUpload } from "./drive/upload-queue.service";
import type { Devis } from "@shared/schema";

const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Maximum retry attempts before we give up on a devis. After this
 * many failed sweeps the row is left with `signed_pdf_next_attempt_at`
 * NULL but `signed_pdf_retry_attempts` = MAX, surfacing it as a dead
 * letter for the operator.
 */
export const MAX_SIGNED_PDF_RETRY_ATTEMPTS = 5;

/**
 * Exponential backoff schedule (ms) keyed by the upcoming attempt
 * number (i.e. `attempts` BEFORE the increment). Entry [0] is the
 * delay between the failed first attempt and the next retry, [1] is
 * after the second attempt, etc. Tuned for an external API whose
 * outages typically resolve in minutes-to-hours.
 */
const RETRY_BACKOFF_MS: readonly number[] = [
  5 * 60_000, // 5min  → attempt 2
  15 * 60_000, // 15min → attempt 3
  60 * 60_000, // 1h    → attempt 4
  4 * 60 * 60_000, // 4h    → attempt 5
];

function nextAttemptAtFromAttempts(currentAttempts: number): Date | null {
  if (currentAttempts >= MAX_SIGNED_PDF_RETRY_ATTEMPTS - 1) return null;
  const delay = RETRY_BACKOFF_MS[currentAttempts] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  return new Date(Date.now() + delay);
}

/**
 * Download a signed PDF body from a short-lived URL with a hard timeout.
 * Returns the bytes on success or throws on any non-2xx / network error.
 */
async function fetchPdfBytes(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} fetching signed PDF`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("Empty response body for signed PDF");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort persist + Drive mirror. Never throws — caller is the
 * Archisign webhook handler which MUST 200 regardless of our audit
 * copy state. All failure modes are logged with a stable prefix so
 * operators can grep `[SignedPdfPersist]` to triage.
 */
export async function persistSignedDevisPdf(devisId: number): Promise<void> {
  try {
    const d = await storage.getDevis(devisId);
    if (!d) {
      console.warn(`[SignedPdfPersist] devis ${devisId} not found — skipping`);
      return;
    }
    if (!d.archisignEnvelopeId) {
      console.warn(
        `[SignedPdfPersist] devis ${devisId} has no archisignEnvelopeId — cannot fetch signed PDF`,
      );
      return;
    }

    let storageKey = d.signedPdfStorageKey ?? null;

    // 1. Download + persist locally (one-shot per devis).
    if (!storageKey) {
      let bytes: Buffer | null = null;
      let giveUp = false;
      let failureMessage: string | null = null;
      try {
        bytes = await downloadSignedPdf(d);
      } catch (err) {
        if (err instanceof ArchisignRetentionBreachError) {
          // Terminal: Archisign has purged the bytes. Stop retrying.
          giveUp = true;
          failureMessage = `retention breach (incidentRef=${err.breach.incidentRef})`;
          console.error(
            `[SignedPdfPersist] devis ${devisId} envelope ${d.archisignEnvelopeId}: ` +
              `Archisign retention breach — bytes no longer retrievable; ` +
              `audit copy will not be saved. incidentRef=${err.breach.incidentRef}`,
          );
        } else {
          failureMessage = err instanceof Error ? err.message : String(err);
          console.error(
            `[SignedPdfPersist] devis ${devisId} envelope ${d.archisignEnvelopeId}: ` +
              `download failed: ${failureMessage}`,
          );
        }
      }

      if (!bytes) {
        // Schedule a retry unless the failure is terminal. Backoff is
        // computed off the row's CURRENT attempt count so the sweeper
        // can pick the same row up later.
        const currentAttempts = d.signedPdfRetryAttempts ?? 0;
        const nextAt = giveUp ? null : nextAttemptAtFromAttempts(currentAttempts);
        await storage.recordSignedPdfPersistFailure(
          devisId,
          failureMessage ?? "unknown",
          nextAt,
        );
        return;
      }

      // Deterministic object name keyed by devisId. Concurrent webhook
      // replays / sweeper retries collapse onto a single physical object
      // (same path → idempotent overwrite with identical signed bytes),
      // so we cannot accumulate duplicate artifacts under racy delivery.
      const objectName = buildSignedDevisObjectName(d.projectId, devisId);
      try {
        storageKey = await uploadDocumentAtKey(objectName, bytes, "application/pdf");
        await storage.setDevisSignedPdfStorageKey(devisId, storageKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[SignedPdfPersist] devis ${devisId}: upload/persist failed: ${message}`,
        );
        const currentAttempts = d.signedPdfRetryAttempts ?? 0;
        await storage.recordSignedPdfPersistFailure(
          devisId,
          message,
          nextAttemptAtFromAttempts(currentAttempts),
        );
        return;
      }
      console.log(
        `[SignedPdfPersist] devis ${devisId} envelope ${d.archisignEnvelopeId}: ` +
          `persisted ${bytes.length} bytes → ${storageKey}`,
      );
      // Clear retry bookkeeping on success.
      await storage.clearSignedPdfRetry(devisId).catch(() => {});
    }

    // 2. Mirror to the per-lot Drive folder. enqueueDriveUpload is a
    //    no-op when the feature flag is off and idempotent on
    //    (docKind, docId) — safe on retries.
    await enqueueDriveUpload({
      docKind: "devis_signed",
      docId: d.id,
      projectId: d.projectId,
      lotId: d.lotId ?? null,
      sourceStorageKey: storageKey,
      // ONE LOT → ONE FOLDER: the file name ends up alongside the
      // original devis PDF in `{Lot} {project} {devisCode}`. Suffix
      // " signed.pdf" keeps it visually grouped with the original
      // and matches the naming convention pinned in task #206.
      displayName: signedPdfFileName(d),
      seedDevisCode: d.devisCode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[SignedPdfPersist] devis ${devisId}: unexpected failure: ${message}`);
  }
}

/**
 * Build the canonical signed-PDF filename: `{devisCode} signed.pdf`.
 * The space is preserved (object storage and Drive both accept it);
 * only path-hostile characters in the devisCode itself are sanitised.
 * Exported so the download route and any future re-mint admin tools
 * stay byte-aligned with what was written into storage / Drive.
 */
export function signedPdfFileName(d: Pick<Devis, "id" | "devisCode">): string {
  const raw = d.devisCode ?? `devis_${d.id}`;
  const safe = raw.replace(/[/\\\u0000-\u001f\u007f]/g, "_");
  return `${safe} signed.pdf`;
}

// ---------------------------------------------------------------------
// Sweeper — process-local periodic job that retries failed signed-PDF
// persistence attempts. Mirrors the design of the Drive upload-queue
// sweeper (server/services/drive/upload-queue.service.ts): single
// in-process timer, claim-by-row pattern via storage.listDueSignedPdfRetries,
// idempotent re-entry guarded by signedPdfStorageKey on the devis row.
// ---------------------------------------------------------------------

let sweeperInterval: ReturnType<typeof setInterval> | null = null;
const SWEEP_BATCH = 20;

export async function sweepDueSignedPdfRetries(): Promise<void> {
  try {
    const due = await storage.listDueSignedPdfRetries(SWEEP_BATCH);
    if (due.length === 0) return;
    console.log(`[SignedPdfPersist] sweep claimed ${due.length} due retries`);
    for (const row of due) {
      await persistSignedDevisPdf(row.id).catch((err) => {
        // persistSignedDevisPdf already swallows its own errors, but
        // keep this guard so a future refactor can't break the loop.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[SignedPdfPersist] sweep attempt for devis ${row.id} threw: ${message}`);
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[SignedPdfPersist] sweep failed: ${message}`);
  }
}

export function startSignedPdfRetrySweeper(intervalMs: number = 5 * 60_000): void {
  if (sweeperInterval) return;
  sweeperInterval = setInterval(() => {
    sweepDueSignedPdfRetries().catch(console.error);
  }, intervalMs);
  console.log(
    `[SignedPdfPersist] retry sweeper started (every ${Math.round(intervalMs / 1000)}s, ` +
      `max ${MAX_SIGNED_PDF_RETRY_ATTEMPTS} attempts per devis)`,
  );
}

export function stopSignedPdfRetrySweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
}

async function downloadSignedPdf(d: Devis): Promise<Buffer> {
  // 1. Snapshot URL from the webhook payload (almost always still
  //    live since webhooks fire near-instant).
  const snapshot = d.signedPdfFetchUrlSnapshot;
  if (snapshot) {
    try {
      return await fetchPdfBytes(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[SignedPdfPersist] devis ${d.id}: snapshot URL failed (${message}); re-minting`,
      );
    }
  }
  // 2. Re-mint via Archisign. This is the path that throws
  //    ArchisignRetentionBreachError on 410 — caught upstream.
  const minted = await getSignedPdfUrl(d.archisignEnvelopeId!);
  return fetchPdfBytes(minted.url);
}
