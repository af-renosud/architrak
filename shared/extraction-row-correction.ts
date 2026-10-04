import { z } from "zod";

const decimal = (scale: number) => z.string().regex(new RegExp(`^-?\\d{1,9}(\\.\\d{1,${scale}})?$`));
export const correctionRowSchema = z.object({
  lineNumber: z.number().int().positive().max(100000),
  description: z.string().trim().min(1).max(10000),
  quantity: decimal(3).nullable(),
  unit: z.string().trim().max(100).nullable(),
  unitPriceHt: decimal(2).nullable(),
  totalHt: decimal(2),
}).strict();
export const extractionCorrectionSchema = z.object({
  kind: z.enum(["missing", "misread"]),
  lineId: z.number().int().positive().optional(),
  row: correctionRowSchema,
  evidence: z.object({
    page: z.number().int().positive(),
    excerpt: z.string().trim().min(10).max(10000),
  }).strict(),
  reason: z.string().trim().min(1).max(2000),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "misread") !== (value.lineId !== undefined))
    ctx.addIssue({ code: "custom", message: "Only misread corrections require an existing line." });
  const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalize(value.evidence.excerpt).includes(normalize(value.row.description)))
    ctx.addIssue({ code: "custom", message: "The corrected description must be transcribed from the quoted source evidence." });
  // Accept French comma decimals and space-grouped thousands, but never figures
  // absent from the supplied source excerpt. No recalculation of contractor prices.
  const excerpt = value.evidence.excerpt.normalize("NFKC");
  const tokens = excerpt.match(/-?\d+(?:[,.]\d+)?/g) ?? [];
  const grouped = excerpt.match(/(?:^|[^\d.,])-?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[,.]\d+)?/g) ?? [];
  const numericEvidence = [...tokens, ...grouped.map(n => n.trim().replace(/[ \u00a0\u202f]/g, ""))]
    .map(n => Number(n.replace(",", ".")));
  for (const key of ["quantity", "unitPriceHt", "totalHt"] as const) {
    if (value.row[key] !== null && !numericEvidence.includes(Number(value.row[key])))
      ctx.addIssue({ code: "custom", message: `${key} must appear in the quoted original PDF evidence.` });
  }
});
export type ExtractionCorrection = z.infer<typeof extractionCorrectionSchema>;