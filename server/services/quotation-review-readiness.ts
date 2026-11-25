import { eq } from "drizzle-orm";
import { db } from "../db";
import { devisReplacements } from "@shared/schema";
import type { ReplacementReviewSummary } from "@shared/quotation-carry-forward";
import { loadQuotationDecisionSnapshot } from "./quotation-decision-snapshot";
import { evaluateQuotationDecision } from "./quotation-decision";
import { getCarryForwardPreview } from "./quotation-carry-forward";

/** Replacement guidance only: never a blocker, never an approval input. */
export async function replacementReviewSummary(devisId: number): Promise<ReplacementReviewSummary | null> {
  const [link] = await db.select().from(devisReplacements).where(eq(devisReplacements.newDevisId, devisId)).limit(1);
  if (!link) return null;
  const preview = await getCarryForwardPreview(link.oldDevisId, devisId);
  const line = (row: { id: number; lineNumber: number; description: string; totalHt: string }) =>
    ({ id: row.id, lineNumber: row.lineNumber, description: row.description, totalHt: row.totalHt });
  const matched = new Map(preview.sourceLines.filter(row => row.suggestedTargetId != null).map(row => [row.suggestedTargetId!, row]));
  const sorted = [...preview.targetLines].sort((a, b) => a.lineNumber - b.lineNumber);
  return {
    previousId: link.oldDevisId, previousLabel: link.oldLabel,
    unchanged: sorted.filter(row => matched.has(row.id) && !matched.get(row.id)!.figuresChanged).map(line),
    figuresChanged: sorted.filter(row => matched.get(row.id)?.figuresChanged)
      .map(row => ({ ...line(row), previousTotalHt: matched.get(row.id)!.totalHt })),
    added: sorted.filter(row => !matched.has(row.id)).map(line),
    removed: preview.sourceLines.filter(row => row.suggestedTargetId == null).sort((a, b) => a.lineNumber - b.lineNumber).map(line),
  };
}

/** Coherent read-only preflight; commit evaluates the same rules under locks. */
export async function quotationReviewReadiness(devisId: number) {
  const snapshot = await loadQuotationDecisionSnapshot(devisId);
  if (!snapshot) return null;
  const decision = await evaluateQuotationDecision(snapshot, "approve");
  let replacement: ReplacementReviewSummary | null = null;
  try { replacement = await replacementReviewSummary(devisId); }
  catch (error) { console.warn("[QuotationReadiness] Replacement summary unavailable:", error instanceof Error ? error.message : "unknown"); }
  return { ...decision, status: snapshot.translation?.status ?? "missing",
    blockers: decision.issues.filter(issue => issue.severity === "blocker"), replacement };
}
