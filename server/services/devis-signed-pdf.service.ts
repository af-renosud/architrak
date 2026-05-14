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
import { uploadDocument } from "../storage/object-storage";
import { enqueueDriveUpload } from "./drive/upload-queue.service";
import type { Devis } from "@shared/schema";

const DOWNLOAD_TIMEOUT_MS = 30_000;

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
      const bytes = await downloadSignedPdf(d).catch((err) => {
        if (err instanceof ArchisignRetentionBreachError) {
          console.error(
            `[SignedPdfPersist] devis ${devisId} envelope ${d.archisignEnvelopeId}: ` +
              `Archisign retention breach — bytes no longer retrievable; ` +
              `audit copy will not be saved. incidentRef=${err.breach.incidentRef}`,
          );
          return null;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[SignedPdfPersist] devis ${devisId} envelope ${d.archisignEnvelopeId}: ` +
            `download failed: ${message}`,
        );
        return null;
      });
      if (!bytes) return;

      const fileName = `signed_${(d.devisCode ?? `devis_${d.id}`).replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`;
      storageKey = await uploadDocument(d.projectId, fileName, bytes, "application/pdf");
      await storage.setDevisSignedPdfStorageKey(devisId, storageKey);
      console.log(
        `[SignedPdfPersist] devis ${devisId} envelope ${d.archisignEnvelopeId}: ` +
          `persisted ${bytes.length} bytes → ${storageKey}`,
      );
    }

    // 2. Mirror to the per-lot Drive folder. enqueueDriveUpload is a
    //    no-op when the feature flag is off and idempotent on
    //    (docKind, docId) — safe on retries.
    const safeCode = (d.devisCode ?? `devis_${d.id}`).replace(/[^a-zA-Z0-9._-]/g, "_");
    await enqueueDriveUpload({
      docKind: "devis_signed",
      docId: d.id,
      projectId: d.projectId,
      lotId: d.lotId ?? null,
      sourceStorageKey: storageKey,
      // ONE LOT → ONE FOLDER: the file name ends up alongside the
      // original devis PDF in `{Lot} {project} {devisCode}`. Prefix
      // `signed_` keeps it sorted next to the original.
      displayName: `signed_${safeCode}.pdf`,
      seedDevisCode: d.devisCode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[SignedPdfPersist] devis ${devisId}: unexpected failure: ${message}`);
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
