import { sql, and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { devis } from "@shared/schema";

export {
  DEVIS_CODE_MAX_LOT_REF,
  DEVIS_CODE_MAX_DESCRIPTION,
  DEVIS_CODE_MAX_NUMBER,
  validateDevisCodeParts,
  composeDevisCode,
  tryParseDevisCode,
  type DevisCodeParts,
  type DevisCodeValidationError,
} from "@shared/devis-code";

/**
 * Compute the next available `lotSequence` for a `(projectId, lotRef)`
 * pair within the project. Case-insensitive. Optionally excludes a
 * specific devis id so the edit form can suggest the existing number
 * back without a self-collision.
 */
export async function findNextLotSequence(
  projectId: number,
  lotRef: string,
  opts: { excludeDevisId?: number } = {},
): Promise<number> {
  const normalized = lotRef.trim();
  if (!normalized) return 1;
  const rows = await db
    .select({ seq: devis.lotSequence })
    .from(devis)
    .where(
      and(
        eq(devis.projectId, projectId),
        sql`lower(${devis.lotRefText}) = lower(${normalized})`,
        isNotNull(devis.lotSequence),
        opts.excludeDevisId ? sql`${devis.id} <> ${opts.excludeDevisId}` : sql`true`,
      ),
    );
  let max = 0;
  for (const r of rows) {
    if (typeof r.seq === "number" && r.seq > max) max = r.seq;
  }
  return max + 1;
}

/**
 * Check whether `(projectId, lotRef, lotSequence)` is already taken by
 * another devis. Used by the confirm / edit endpoints to surface a clear
 * collision message before the partial unique index would reject the
 * insert/update.
 */
export async function isLotSequenceTaken(
  projectId: number,
  lotRef: string,
  lotSequence: number,
  opts: { excludeDevisId?: number } = {},
): Promise<boolean> {
  const normalized = lotRef.trim();
  if (!normalized) return false;
  const rows = await db
    .select({ id: devis.id })
    .from(devis)
    .where(
      and(
        eq(devis.projectId, projectId),
        sql`lower(${devis.lotRefText}) = lower(${normalized})`,
        eq(devis.lotSequence, lotSequence),
        opts.excludeDevisId ? sql`${devis.id} <> ${opts.excludeDevisId}` : sql`true`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
