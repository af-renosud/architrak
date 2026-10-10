import { z } from "zod";

const money = z.string().trim().regex(/^\d{1,10}(?:\.\d{1,2})?$/, "Enter an amount with at most two decimal places")
  .transform(value => Number(value).toFixed(2));
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform(v => v || null);
export const externalWorkInput = z.object({
  reference: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  amountHt: money,
  amountTtc: money,
  companyName: optionalText(200),
  lot: optionalText(120),
  completionDate: optionalText(10).refine(v => !v || (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v), "Enter a valid date"),
  confirmedCompleted: z.literal(true),
  acknowledgeOverlap: z.boolean().optional(),
  version: z.number().int().positive().optional(),
}).strict().refine(v => Number(v.amountTtc) >= Number(v.amountHt), { path: ["amountTtc"], message: "TTC must not be less than HT" });

export function normalizeExternalReference(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

export interface ExternalCostRow {
  id: number;
  reference: string;
  description: string;
  companyName: string | null;
  lot: string | null;
  completionDate: string | null;
  amountHt: string;
  amountTtc: string;
}
export interface ExternalCostOverview {
  entries: ExternalCostRow[];
  totalExternalHt: number;
  totalExternalTtc: number;
  totalCombinedCostHt: number;
  totalCombinedCostTtc: number;
}
