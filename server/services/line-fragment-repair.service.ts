// Task #356 — Targeted repair for a continuation-paragraph fragment that was
// extracted as its own numbered line item (prod DVP0000661: the PDF's item 6
// was split, the continuation paragraph became a phantom 0.00 € line 7, and
// every later line number shifted — the translation tab had to be hand-edited
// to compensate).
//
// The repair merges the fragment line back into its predecessor, renumbers
// the following lines, mirrors the merge into the persisted aiExtractedData
// JSON, and realigns the translation entries WITHOUT losing manual edits.
// Guarded so it can only touch a line that demonstrably is a fragment.

import { eq, gt, sql, and } from "drizzle-orm";
import { db } from "../db";
import { devis, devisLineItems, devisLineContexts, devisLineContextAssets, devisTranslations, situationLines } from "@shared/schema";
import type { DevisTranslationLine } from "@shared/schema";
import { LEADING_ITEM_REF } from "./extraction-completeness";

export interface FragmentRepairResult {
  success: boolean;
  status: number;
  message: string;
  mergedDescription?: string;
  remainingLineCount?: number;
}

interface ExtractedLineItem {
  description?: string;
  total?: number | null;
  unitPrice?: number | null;
  [k: string]: unknown;
}

/**
 * Pure: merge element at `fragmentIndex` (0-based) into its predecessor in an
 * extracted lineItems array. Predecessor keeps its own amounts/geometry.
 */
export function applyFragmentMergeToExtractedItems(
  items: ExtractedLineItem[],
  fragmentIndex: number,
): ExtractedLineItem[] {
  if (fragmentIndex <= 0 || fragmentIndex >= items.length) return items;
  const out = items.map((i) => ({ ...i }));
  const fragment = out[fragmentIndex];
  const primary = out[fragmentIndex - 1];
  const fragText = (fragment.description ?? "").trim();
  if (fragText.length > 0) {
    primary.description = `${(primary.description ?? "").trim()}\n${fragText}`.trim();
  }
  out.splice(fragmentIndex, 1);
  return out;
}

/**
 * Pure: realign translation entries after merging line `fragmentLineNumber`
 * into `fragmentLineNumber - 1` (both 1-based, matching lineNumber fields).
 *  - the fragment's entry is dropped as a separate row, but its translation
 *    TEXT is never discarded: with no `cleanedTranslation`, a non-empty
 *    fragment translation is appended to the primary entry's translation
 *    (marked edited when either source was hand-edited);
 *  - later entries have lineNumber decremented;
 *  - the primary entry's originalDescription becomes the merged French text
 *    and, when `cleanedTranslation` is provided, its translation is replaced
 *    (marked edited) — other manual edits are preserved verbatim.
 */
export function applyFragmentMergeToTranslations(
  lines: DevisTranslationLine[],
  fragmentLineNumber: number,
  mergedOriginalDescription: string,
  cleanedTranslation?: string,
): DevisTranslationLine[] {
  const fragmentEntry = lines.find((l) => l.lineNumber === fragmentLineNumber);
  const fragmentText = (fragmentEntry?.translation ?? "").trim();
  const out: DevisTranslationLine[] = [];
  for (const line of lines) {
    if (line.lineNumber === fragmentLineNumber) continue; // folded, not lost
    const copy = { ...line };
    if (copy.lineNumber === fragmentLineNumber - 1) {
      copy.originalDescription = mergedOriginalDescription;
      if (cleanedTranslation != null) {
        copy.translation = cleanedTranslation;
        copy.edited = true;
      } else if (fragmentText.length > 0) {
        // Preserve a hand-written continuation translation by folding it
        // into the primary entry, mirroring the French-side merge.
        copy.translation = `${(copy.translation ?? "").trim()}\n${fragmentText}`.trim();
        if (fragmentEntry?.edited || copy.edited) copy.edited = true;
      }
    } else if (copy.lineNumber > fragmentLineNumber) {
      copy.lineNumber = copy.lineNumber - 1;
    }
    out.push(copy);
  }
  return out;
}

/** Devis states in which line structure is immutable — a signed/finalised
 *  document must never have its line numbering rewritten in place. */
const REPAIR_FORBIDDEN_DEVIS_STATUSES = new Set(["signed", "rejected", "cancelled"]);

/** The signing lifecycle lives in `devis.signOffStage`, not `status`.
 *  Eligibility is defined POSITIVELY: only the pre-client stages, where the
 *  document is still an internal working copy, may have their line structure
 *  rewritten. Anything the client has seen, agreed to, rejected, signed —
 *  or a voided document — is immutable. */
const REPAIR_ELIGIBLE_SIGN_OFF_STAGES = new Set(["received", "checked_internal"]);

export async function repairLineFragment(input: {
  devisId: number;
  fragmentLineNumber: number;
  cleanedTranslation?: string;
}): Promise<FragmentRepairResult> {
  const { devisId, fragmentLineNumber, cleanedTranslation } = input;

  // All reads AND guards run inside the same transaction, with the devis and
  // its line rows locked FOR UPDATE, so a concurrent edit cannot slip between
  // guard evaluation and the destructive writes.
  return await db.transaction(async (tx): Promise<FragmentRepairResult> => {
    const [devisRow] = await tx.select().from(devis).where(eq(devis.id, devisId)).for("update");
    if (!devisRow) return { success: false, status: 404, message: "Devis not found" };
    if (REPAIR_FORBIDDEN_DEVIS_STATUSES.has(devisRow.status)) {
      return { success: false, status: 422, message: `Devis is ${devisRow.status} — its line structure is immutable.` };
    }
    if (!REPAIR_ELIGIBLE_SIGN_OFF_STAGES.has(devisRow.signOffStage)) {
      return { success: false, status: 422, message: `Devis sign-off stage is ${devisRow.signOffStage} — only pre-client stages (received, checked_internal) allow line-structure repair.` };
    }

    const lines = await tx
      .select()
      .from(devisLineItems)
      .where(eq(devisLineItems.devisId, devisId))
      .orderBy(devisLineItems.lineNumber)
      .for("update");

    const fragment = lines.find((l) => l.lineNumber === fragmentLineNumber);
    const primary = lines.find((l) => l.lineNumber === fragmentLineNumber - 1);
    if (!fragment) {
      return { success: false, status: 404, message: `No line ${fragmentLineNumber} on devis ${devisId}` };
    }
    if (!primary) {
      return { success: false, status: 422, message: `Line ${fragmentLineNumber} has no predecessor to merge into` };
    }
    if (lines.filter((l) => l.lineNumber === fragmentLineNumber).length > 1
      || lines.filter((l) => l.lineNumber === fragmentLineNumber - 1).length > 1) {
      return { success: false, status: 422, message: `Duplicate line numbers around line ${fragmentLineNumber} — resolve the numbering manually first.` };
    }

    // ── Guards: only a demonstrable fragment may be merged away ────────────
    const fragTotal = Number(fragment.totalHt ?? 0);
    const fragUnit = Number(fragment.unitPriceHt ?? 0);
    if (fragTotal !== 0 || fragUnit !== 0) {
      return { success: false, status: 422, message: `Line ${fragmentLineNumber} carries its own amounts (total ${fragment.totalHt}) — refusing to merge a priced line.` };
    }
    const fragDesc = (fragment.description ?? "").trim();
    if (LEADING_ITEM_REF.test(fragDesc)) {
      return { success: false, status: 422, message: `Line ${fragmentLineNumber} starts with its own item/lot reference — it is a real item, not a fragment.` };
    }
    if (Number(fragment.percentComplete ?? 0) !== 0) {
      return { success: false, status: 422, message: `Line ${fragmentLineNumber} has progress recorded (${fragment.percentComplete}%) — resolve progress tracking first.` };
    }
    const [situationRef] = await tx
      .select({ id: situationLines.id })
      .from(situationLines)
      .where(eq(situationLines.devisLineItemId, fragment.id))
      .limit(1);
    if (situationRef) {
      return { success: false, status: 422, message: `Line ${fragmentLineNumber} is referenced by a situation — refusing to delete it.` };
    }
    // Deleting the fragment row would CASCADE-delete any architect-authored
    // context document (and its assets) attached to it — refuse instead.
    const [contextRef] = await tx
      .select({ id: devisLineContexts.id })
      .from(devisLineContexts)
      .where(eq(devisLineContexts.devisLineItemId, fragment.id))
      .limit(1);
    if (contextRef) {
      return { success: false, status: 422, message: `Line ${fragmentLineNumber} has a context document attached — delete or move it first.` };
    }
    // Assets can exist WITHOUT a context document (interrupted save, removed
    // document) and also cascade from the line row — deleting the line would
    // orphan their objects in storage. Refuse; the orphan-asset sweeper (or a
    // manual cleanup) must clear them first.
    const [assetRef] = await tx
      .select({ id: devisLineContextAssets.id })
      .from(devisLineContextAssets)
      .where(eq(devisLineContextAssets.devisLineItemId, fragment.id))
      .limit(1);
    if (assetRef) {
      return { success: false, status: 422, message: `Line ${fragmentLineNumber} has uploaded context assets attached — delete them first (or let the orphan sweeper reclaim them).` };
    }

    const [translation] = await tx
      .select()
      .from(devisTranslations)
      .where(eq(devisTranslations.devisId, devisId))
      .for("update");
    if (translation?.status === "finalised") {
      return { success: false, status: 422, message: "The translation is finalised — reopen it before repairing line structure." };
    }
    const translationLines = translation && Array.isArray(translation.lineTranslations)
      ? (translation.lineTranslations as DevisTranslationLine[])
      : null;
    if (translationLines) {
      const seen = new Set<number>();
      for (const l of translationLines) {
        if (seen.has(l.lineNumber)) {
          return { success: false, status: 422, message: `Translation has duplicate entries for line ${l.lineNumber} — resolve manually first.` };
        }
        seen.add(l.lineNumber);
      }
    }

    const mergedDescription = fragDesc.length > 0
      ? `${(primary.description ?? "").trim()}\n${fragDesc}`.trim()
      : (primary.description ?? "").trim();

    // 1. Merge descriptions on the primary row; drop the fragment row.
    await tx
      .update(devisLineItems)
      .set({ description: mergedDescription })
      .where(eq(devisLineItems.id, primary.id));
    await tx.delete(devisLineItems).where(eq(devisLineItems.id, fragment.id));

    // 2. Renumber every following line down by one.
    await tx
      .update(devisLineItems)
      .set({ lineNumber: sql`${devisLineItems.lineNumber} - 1` })
      .where(and(eq(devisLineItems.devisId, devisId), gt(devisLineItems.lineNumber, fragmentLineNumber)));

    // 3. Mirror the merge into the persisted extraction JSON (audit trail
    //    consistency). Only when the stored array still matches the stored
    //    line rows one-to-one by ordinal AND the element at the fragment's
    //    ordinal actually looks like the fragment (content check) — an
    //    equal-length but reordered array must be left untouched.
    const extracted = (devisRow.aiExtractedData ?? null) as { lineItems?: ExtractedLineItem[] } | null;
    if (extracted && Array.isArray(extracted.lineItems) && extracted.lineItems.length === lines.length) {
      const candidate = extracted.lineItems[fragmentLineNumber - 1];
      const candDesc = (candidate?.description ?? "").trim();
      const candTotal = candidate?.total;
      const contentMatches =
        candidate != null
        && (candTotal == null || Number(candTotal) === 0)
        && (fragDesc.length === 0 || candDesc.slice(0, 30) === fragDesc.slice(0, 30));
      if (contentMatches) {
        const mergedItems = applyFragmentMergeToExtractedItems(extracted.lineItems, fragmentLineNumber - 1);
        await tx
          .update(devis)
          .set({ aiExtractedData: { ...extracted, lineItems: mergedItems } })
          .where(eq(devis.id, devisId));
      } else {
        console.warn(`[LineFragmentRepair] devis ${devisId}: aiExtractedData ordinal ${fragmentLineNumber - 1} does not match the fragment row — leaving the extraction JSON untouched`);
      }
    }

    // 4. Realign translations, preserving manual edits. Bump contextsVersion
    //    so any cached rendered translation PDF is invalidated.
    if (translation && translationLines) {
      const realigned = applyFragmentMergeToTranslations(
        translationLines,
        fragmentLineNumber,
        mergedDescription,
        cleanedTranslation,
      );
      await tx
        .update(devisTranslations)
        .set({
          lineTranslations: realigned,
          // Drop cached rendered PDFs — they still show the phantom line and
          // old numbering — and bump contextsVersion so an in-flight publish
          // from a stale snapshot cannot resurrect them.
          translatedPdfStorageKey: null,
          combinedPdfStorageKey: null,
          contextsVersion: sql`${devisTranslations.contextsVersion} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(devisTranslations.devisId, devisId));
    }

    console.log(`[LineFragmentRepair] devis ${devisId}: merged line ${fragmentLineNumber} into ${fragmentLineNumber - 1}, renumbered ${lines.length - fragmentLineNumber} following line(s)`);
    return {
      success: true,
      status: 200,
      message: `Merged line ${fragmentLineNumber} into line ${fragmentLineNumber - 1}; ${lines.length - 1} lines remain.`,
      mergedDescription,
      remainingLineCount: lines.length - 1,
    };
  });
}
