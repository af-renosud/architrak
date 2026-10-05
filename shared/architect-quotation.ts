import { z } from "zod";

const money = z.string().regex(/^-?\d{1,10}(?:\.\d{1,2})?$/, "Use a decimal amount with at most two decimal places.");
const quantity = z.string().regex(/^(?:-?\d{1,9}(?:\.\d{1,3})?)?$/, "Use a quantity with at most three decimal places.");
const vat = z.string().refine(value => value === "" || /^\d{1,3}(?:\.\d{1,3})?$/.test(value) && Number(value) <= 100,
  "Enter the actual VAT rate (0 to 100), or leave unknown for text-only edits.");
export const architectCorrectionLineSchema = z.object({
  id: z.number().int().positive().nullable(), clientKey: z.string().min(1).max(100),
  kind: z.enum(["priced", "context"]), descriptionFr: z.string().max(100000), descriptionEn: z.string().max(100000),
  explanationFr: z.string().max(100000), explanationEn: z.string().max(100000),
  quantity, unit: z.string().max(100), unitPriceHt: z.union([money, z.literal("")]), totalHt: money, vatRate: vat, included: z.boolean(),
}).strict();
export const architectCorrectionDraftSchema = z.object({
  headerFr: z.string().max(100000), headerEn: z.string().max(100000), explanationFr: z.string().max(100000),
  explanationEn: z.string().max(100000), summaryEn: z.string().max(100000), discountHt: money,
  vatRounding: z.enum(["bucket", "line"]).optional(),
  lines: z.array(architectCorrectionLineSchema).max(1000),
}).strict();
export const architectCorrectionSaveSchema = architectCorrectionDraftSchema.extend({ expectedVersion: z.string().min(1).max(128) });
export const architectBaselineConfirmationSchema = z.object({
  expectedVersion: z.string().min(1).max(128), ttc: money.refine(v => !v.startsWith("-")),
  page: z.number().int().positive(), confirmedFromPdf: z.literal(true),
}).strict();
export type ArchitectCorrectionLine = z.infer<typeof architectCorrectionLineSchema>;
export type ArchitectCorrectionDraft = z.infer<typeof architectCorrectionDraftSchema>;
export type ArchitectCorrectionSave = z.infer<typeof architectCorrectionSaveSchema>;
export type ArchitectBaselineConfirmation = z.infer<typeof architectBaselineConfirmationSchema>;
export interface ArchitectCorrectionSnapshot {
  version: string; draft: ArchitectCorrectionDraft;
  workingTotals?: { ht: string; ttc: string };
  baseline: { ttc: string; sourceFileName: string; sourceDigest: string; confirmedAt: string; confirmedBy: string } | null;
  blockedReason: string | null; financialBlockedReason: string | null; advisoryMessages: string[];
  history: Array<{ id: number; actor: string; savedAt: string; summary: string }>;
}
const ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), HUNDRED = BigInt(100);
function divide(n: bigint, d: bigint) {
  if (d <= ZERO) throw new Error("Invalid divisor");
  return (n < ZERO ? -ONE : ONE) * (((n < ZERO ? -n : n) + d / TWO) / d);
}
function decimal(value: string) {
  if (!/^-?\d+(?:\.\d+)?$/.test(value) || value.length > 32) throw new Error("Enter a valid decimal number using a dot.");
  const [integer, fraction = ""] = value.split(".");
  if (fraction.length > 6) throw new Error("Use at most six decimal places.");
  return { n: BigInt(`${integer.replace("-", "")}${fraction}`) * (integer.startsWith("-") ? -ONE : ONE),
    d: BigInt(`1${"0".repeat(fraction.length)}`) };
}
export function correctionCents(value: string) { const v = decimal(value); return divide(v.n * HUNDRED, v.d); }
export function correctionMoney(value: bigint) {
  const n = value < ZERO ? -value : value;
  return `${value < ZERO ? "-" : ""}${n / HUNDRED}.${String(n % HUNDRED).padStart(2, "0")}`;
}
export function correctionProduct(q: string, p: string) {
  const a = decimal(q), b = decimal(p);
  return correctionMoney(divide(a.n * b.n * HUNDRED, a.d * b.d));
}
/** Exact cents, explicit VAT, net buckets, proportional HT discount with
 * largest-remainder cent allocation. No header totals or inferred 20% rate.
 * Optional line rounding is available for source PDFs using line-level VAT.
 */
export function previewCorrectionTotals(draft: ArchitectCorrectionDraft) {
  const buckets = new Map<string, { ht: bigint; rate: { n: bigint; d: bigint } }>();
  for (let index = 0; index < draft.lines.length; index++) {
    const line = draft.lines[index];
    if (line.kind === "context" || !line.included) continue;
    const rate = decimal(line.vatRate), amount = correctionCents(line.totalHt);
    if (rate.n < ZERO || rate.n > HUNDRED * rate.d) throw new Error("VAT must be between zero and 100%.");
    const key = draft.vatRounding === "line" ? line.clientKey : String(rate.n * BigInt(1000000) / rate.d);
    const existing = buckets.get(key);
    if (existing) existing.ht += amount;
    else buckets.set(key, { ht: amount, rate });
  }
  // Tie-breaking cannot depend on display order: reordering content must not
  // allocate a discount cent to a different VAT treatment.
  const entries = Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([, b]) => b);
  if (entries.some(b => b.ht < ZERO)) throw new Error("Discount/VAT buckets cannot have a negative net HT.");
  const grossHt = entries.reduce((sum, b) => sum + b.ht, ZERO), discount = correctionCents(draft.discountHt);
  if (discount < ZERO || discount > grossHt) throw new Error("The HT discount must be between zero and the included HT total.");
  const allocated = entries.map((b, index) => ({ ...b, index,
    discount: grossHt ? discount * b.ht / grossHt : ZERO,
    remainder: grossHt ? discount * b.ht % grossHt : ZERO }));
  let remaining = discount - allocated.reduce((sum, b) => sum + b.discount, ZERO);
  for (const b of [...allocated].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (!remaining) break;
    b.discount++; remaining--;
  }
  const ht = grossHt - discount;
  const vatTotal = allocated.reduce((sum, b) => sum + divide((b.ht - b.discount) * b.rate.n, b.rate.d * HUNDRED), ZERO);
  return { ht: correctionMoney(ht), vat: correctionMoney(vatTotal), ttc: correctionMoney(ht + vatTotal) };
}
export function financialProjection(draft: ArchitectCorrectionDraft) {
  return JSON.stringify({ discountHt: draft.discountHt, vatRounding: draft.vatRounding ?? "bucket",
    lines: draft.lines.filter(l => l.kind === "priced").map(({ id, clientKey, quantity, unit, unitPriceHt, totalHt, vatRate, included }) =>
      ({ id, clientKey, quantity, unit, unitPriceHt, totalHt, vatRate, included })).sort((a, b) => a.clientKey.localeCompare(b.clientKey)) });
}
