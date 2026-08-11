/**
 * Task #421 — dismiss ("not relevant") a document from the email queue.
 *
 * Reuses the existing terminal disposition instead of hard-deleting the row:
 *  - extractionStatus = 'skipped' (immutable, excluded from the processor
 *    claim, blocked from intake mirroring — Task #322 guarantees),
 *  - intakeDeletedAt tombstone (blocks mirror resurrection),
 *  - un-promoted intake mirror row removed (intake_jobs cascade via FK),
 *  - stored file deleted best-effort, ONLY when no other persisted row
 *    references the same storage key.
 *
 * All guards and writes are executed atomically inside
 * storage.dismissEmailDocumentAtomically (row locks close the TOCTOU window
 * against concurrent processing/promotion). A document promoted into a typed
 * record (devis / facture) is REFUSED: those are accounting records under the
 * 10-year retention rule and must be handled through their own records.
 */
import { storage } from "../storage";
import { deleteDocument } from "../storage/object-storage";

export class DismissRefusedError extends Error {}

export type DismissOutcome =
  | { outcome: "not_found" }
  | { outcome: "already_dismissed"; id: number }
  | { outcome: "dismissed"; id: number };

export async function dismissEmailDocument(id: number): Promise<DismissOutcome> {
  const result = await storage.dismissEmailDocumentAtomically(id);
  if (result.outcome === "not_found") return { outcome: "not_found" };
  if (result.outcome === "already_dismissed") return { outcome: "already_dismissed", id };
  if (result.outcome === "refused") throw new DismissRefusedError(result.message);

  // Best-effort storage cleanup after commit — a failed object delete must
  // not undo the dismissal, and a key still referenced elsewhere (mirror
  // copies, legacy project documents, duplicate emails) must never be
  // deleted out from under the other row.
  if (result.storageKey) {
    try {
      if (await storage.isStorageKeyReferencedElsewhere(result.storageKey, id)) {
        console.log(`[email-dismiss] Storage key for email doc ${id} still referenced elsewhere — keeping object`);
      } else {
        await deleteDocument(result.storageKey);
      }
    } catch (err) {
      console.warn(`[email-dismiss] Failed to delete storage object for email doc ${id} (continuing):`, err);
    }
  }

  console.log(`[email-dismiss] Dismissed email document ${id} as not relevant`);
  return { outcome: "dismissed", id };
}
