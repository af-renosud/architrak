/** Read only the saved document extraction, never mutable working header/row totals.
 * This is a suggestion for a human PDF comparison, not verification evidence. */
export function extractedSourceTotal(evidence: unknown): { ttc: string } | null {
  if (!evidence || typeof evidence !== "object") return null;
  const amount = (evidence as { amountTtc?: unknown }).amountTtc;
  if (typeof amount !== "number" && typeof amount !== "string") return null;
  const text = String(amount);
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(Number(text))) return null;
  return { ttc: Number(text).toFixed(2) };
}
