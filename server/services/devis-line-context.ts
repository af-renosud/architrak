import { storage } from "../storage";
import { uploadDocument, deleteDocument } from "../storage/object-storage";
import {
  contextDocSchema,
  collectContextAssetIds,
  isContextDocEmpty,
  CONTEXT_ASSET_MAX_BYTES,
  CONTEXT_ASSETS_MAX_PER_LINE,
  type ContextAssetMime,
  type ContextDoc,
} from "@shared/context-doc";
import type { DevisLineContext, DevisLineContextAsset } from "@shared/schema";

/**
 * Business logic for per-line rich-text "context" documents on a devis
 * (rendered into the translated PDF). Routes stay thin; everything
 * security-relevant lives here:
 *   - the document is re-validated against the strict shared schema,
 *   - the line item must belong to the devis in the URL,
 *   - every image node must reference an asset uploaded for that same line,
 *   - saves use optimistic concurrency (revision) — stale saves conflict,
 *   - image uploads are magic-byte sniffed (PNG/JPEG/WebP only, no SVG).
 */

export class LineContextError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 413,
  ) {
    super(message);
    this.name = "LineContextError";
  }
}

/**
 * Once a translation is finalised its PDFs are approval/sign-off artifacts;
 * context edits would silently alter what was approved (including the public
 * Archisign copy). Mirrors the existing "no retranslation after finalisation"
 * rule.
 */
async function rejectWhenFinalised(devisId: number): Promise<void> {
  const translation = await storage.getDevisTranslation(devisId);
  if (translation?.status === "finalised") {
    throw new LineContextError(
      "Translation is finalised — line contexts can no longer be changed",
      409,
    );
  }
}

async function requireLineOnDevis(devisId: number, devisLineItemId: number) {
  const lines = await storage.getDevisLineItems(devisId);
  const line = lines.find((l) => l.id === devisLineItemId);
  if (!line) {
    throw new LineContextError(`Line item ${devisLineItemId} not found on devis ${devisId}`, 404);
  }
  return line;
}

export async function getLineContextsForDevis(devisId: number): Promise<DevisLineContext[]> {
  return storage.getDevisLineContexts(devisId);
}

export interface SaveLineContextInput {
  devisId: number;
  devisLineItemId: number;
  document: unknown;
  /**
   * Revision the client based its edit on. Required when a context row
   * already exists; a mismatch throws a 409 LineContextError. For the very
   * first save (no row yet) the client sends 0.
   */
  baseRevision: number;
}

export async function saveLineContext(input: SaveLineContextInput): Promise<DevisLineContext> {
  const { devisId, devisLineItemId, baseRevision } = input;
  await rejectWhenFinalised(devisId);
  await requireLineOnDevis(devisId, devisLineItemId);

  const parsed = contextDocSchema.safeParse(input.document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new LineContextError(
      `Invalid context document: ${first?.message ?? "schema violation"}${first?.path?.length ? ` at ${first.path.join(".")}` : ""}`,
      400,
    );
  }
  const doc: ContextDoc = parsed.data;

  // Every referenced image must be an asset uploaded for THIS line — the
  // document can never point the PDF renderer at someone else's objects.
  const referencedIds = collectContextAssetIds(doc);
  if (referencedIds.length > 0) {
    const owned = await storage.getDevisLineContextAssets(devisLineItemId);
    const ownedIds = new Set(owned.map((a) => a.id));
    const foreign = referencedIds.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      throw new LineContextError(
        `Context references image asset(s) not uploaded for this line: ${foreign.join(", ")}`,
        400,
      );
    }
  }

  // The write itself is a single guarded transaction (see storage): the
  // finalisation check, the create/optimistic-update, and the atomic
  // contexts_version bump + cache-key clear all commit together, serialized
  // against a concurrent finalise by the translation-row lock. The
  // rejectWhenFinalised() pre-check above is only a fast path — this is the
  // authoritative guard.
  const result = await storage.saveDevisLineContextGuarded(devisId, devisLineItemId, doc, baseRevision);
  switch (result.outcome) {
    case "finalised":
      throw new LineContextError(
        "Translation is finalised — line contexts can no longer be changed",
        409,
      );
    case "stale_create":
      // Concurrent first-save race: another writer inserted the row between
      // the client's read and this insert. Same contract as a stale revision.
      throw new LineContextError(
        "Context was created concurrently — reload the latest version before saving again",
        409,
      );
    case "stale_update":
      throw new LineContextError(
        "Context was modified by someone else — reload the latest version before saving again",
        409,
      );
    case "saved":
      return result.row;
  }
}

function sniffImageMime(buffer: Buffer): ContextAssetMime | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function uploadLineContextAsset(
  devisId: number,
  devisLineItemId: number,
  buffer: Buffer,
): Promise<DevisLineContextAsset> {
  await rejectWhenFinalised(devisId);
  const line = await requireLineOnDevis(devisId, devisLineItemId);

  if (!buffer || buffer.length === 0) {
    throw new LineContextError("Empty upload", 400);
  }
  if (buffer.length > CONTEXT_ASSET_MAX_BYTES) {
    throw new LineContextError(
      `Image too large (${buffer.length} bytes; max ${CONTEXT_ASSET_MAX_BYTES})`,
      413,
    );
  }

  // Content-Type headers are not trusted — the bytes decide. SVG (XML/script
  // capable) is deliberately unsupported.
  const mime = sniffImageMime(buffer);
  if (!mime) {
    throw new LineContextError("Unsupported image type — only PNG, JPEG and WebP are accepted", 400);
  }

  const existing = await storage.getDevisLineContextAssets(devisLineItemId);
  if (existing.length >= CONTEXT_ASSETS_MAX_PER_LINE) {
    throw new LineContextError(
      `Too many images on this line (max ${CONTEXT_ASSETS_MAX_PER_LINE})`,
      400,
    );
  }

  const devis = await storage.getDevis(devisId);
  const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp";
  const fileName = `devis-${devisId}-line-${line.id}-context.${ext}`;
  const storageKey = await uploadDocument(devis?.projectId ?? null, fileName, buffer, mime);

  const created = await storage.createDevisLineContextAsset({
    devisLineItemId,
    devisId,
    storageKey,
    mimeType: mime,
    sizeBytes: buffer.length,
  });
  if (!created) {
    // DB-enforced finalisation guard fired (translation finalised while the
    // upload was in flight) — the asset row was never committed.
    throw new LineContextError(
      "Translation is finalised — line contexts can no longer be changed",
      409,
    );
  }
  return created;
}

/**
 * Fetch an asset and verify it belongs to the given devis before serving.
 */
export async function getOwnedContextAsset(
  devisId: number,
  assetId: number,
): Promise<DevisLineContextAsset> {
  const asset = await storage.getDevisLineContextAsset(assetId);
  if (!asset || asset.devisId !== devisId) {
    throw new LineContextError(`Asset ${assetId} not found on devis ${devisId}`, 404);
  }
  return asset;
}

// ---------------------------------------------------------------------------
// Orphaned-asset cleanup (Task: clean up context images removed from notes).
//
// An asset row + stored object become orphans when the user deletes the
// image from the editor (the saved document no longer references the id) or
// abandons an upload without ever saving. Two complementary mechanisms:
//   1. a periodic sweeper deletes assets older than the grace period that
//      are not referenced by their line's CURRENT context document;
//   2. explicit deletion paths (line-item delete, rescrape's wholesale line
//      replacement) delete the stored objects for the rows the DB cascade
//      is about to remove / just removed.
// ---------------------------------------------------------------------------

/**
 * Grace period before an unreferenced asset is eligible for deletion. Long
 * enough that an in-progress edit (image uploaded, save not yet clicked)
 * can never race the sweeper.
 */
export const CONTEXT_ASSET_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Upper bound of candidate rows examined per sweep pass. */
export const CONTEXT_ASSET_SWEEP_BATCH = 200;

/**
 * Best-effort deletion of the stored objects behind a set of asset rows.
 * Used by the deletion paths where the DB rows are (about to be) removed
 * by FK cascade — object-storage failures are logged, never thrown, so a
 * flaky storage backend cannot block the user-facing delete.
 */
export async function deleteContextAssetObjects(
  assets: ReadonlyArray<Pick<DevisLineContextAsset, "id" | "storageKey">>,
): Promise<void> {
  for (const asset of assets) {
    try {
      await deleteDocument(asset.storageKey);
    } catch (err) {
      console.error(
        `[LineContext] Failed to delete stored object for context asset ${asset.id} (${asset.storageKey}):`,
        err,
      );
    }
  }
}

export interface ContextAssetSweepResult {
  scanned: number;
  deleted: number;
  failures: number;
}

/**
 * One sweep pass: delete asset rows (and their stored objects) that are
 * older than the grace period and no longer referenced by their line's
 * current context document.
 *
 * Ordering is deliberate — the ROW is deleted first. Save-time ownership
 * validation derives the allowed ids from the asset rows, so once the row
 * is gone a racing save that still references this id fails with 400
 * instead of committing a dangling image reference into the document.
 * A failed object delete after a successful row delete is logged loudly
 * (that one object leaks); the reverse order would instead risk documents
 * pointing at vanished objects.
 */
export async function sweepOrphanedContextAssets(
  now: Date = new Date(),
): Promise<ContextAssetSweepResult> {
  const cutoff = new Date(now.getTime() - CONTEXT_ASSET_ORPHAN_GRACE_MS);
  const candidates = await storage.listStaleDevisLineContextAssets(cutoff, CONTEXT_ASSET_SWEEP_BATCH);
  const result: ContextAssetSweepResult = { scanned: candidates.length, deleted: 0, failures: 0 };

  for (const { asset, document } of candidates) {
    try {
      let referenced = false;
      if (document != null) {
        try {
          referenced = collectContextAssetIds(document as ContextDoc).includes(asset.id);
        } catch {
          // Unwalkable document (should never happen — it was schema-validated
          // at save time). Be conservative: treat the asset as referenced.
          referenced = true;
        }
      }
      if (referenced) continue;

      const removed = await storage.deleteDevisLineContextAsset(asset.id);
      if (!removed) continue; // concurrently deleted (cascade or another sweep)

      try {
        await deleteDocument(removed.storageKey);
      } catch (err) {
        result.failures++;
        console.error(
          `[LineContext] Orphan sweep: asset row ${asset.id} deleted but stored object ${removed.storageKey} could not be removed:`,
          err,
        );
      }
      result.deleted++;
    } catch (err) {
      result.failures++;
      console.error(`[LineContext] Orphan sweep failed for asset ${asset.id}:`, err);
    }
  }

  if (result.deleted > 0 || result.failures > 0) {
    console.log(
      `[LineContext] Orphan sweep: scanned=${result.scanned} deleted=${result.deleted} failures=${result.failures}`,
    );
  }
  return result;
}

let sweepTimer: NodeJS.Timeout | null = null;

/** Idempotent process-local starter, mirroring the other sweepers. */
export function startContextAssetSweeper(intervalMs: number = 60 * 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepOrphanedContextAssets().catch((err) =>
      console.error("[LineContext] Orphan sweep pass crashed:", err),
    );
  }, intervalMs);
  sweepTimer.unref?.();
  console.log(`[LineContext] Orphaned context-asset sweeper started (every ${intervalMs / 1000}s)`);
}

export function stopContextAssetSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export { isContextDocEmpty };
