import { z } from "zod";
import type { ContextDoc } from "./context-doc";

export const carrySetupKeys = ["descriptionUk", "descriptionFr", "ref2", "lotId", "devisCode", "feePercentageOverride", "invoicingMode", "marcheId"] as const;
export const carryForwardSchema = z.object({
  version: z.string().min(1),
  setup: z.array(z.enum(carrySetupKeys)).max(8),
  header: z.boolean(),
  supportingPdfIds: z.array(z.number().int().positive()).max(100),
  lines: z.array(z.object({
    sourceLineId: z.number().int().positive(),
    targetLineId: z.number().int().positive(),
    context: z.boolean(),
    translation: z.boolean(),
    wording: z.boolean().optional(),
  }).strict()).max(1000),
}).strict();
export type CarryForwardSelection = z.infer<typeof carryForwardSchema>;
export interface CarryLine {
  id: number;
  lineNumber: number;
  description: string;
  quantity: string;
  unit: string | null;
  unitPriceHt: string;
  totalHt: string;
  translation: string | null;
  explanation?: string | null;
  explanationFr?: string | null;
  context: ContextDoc | null;
  imageCount: number;
  suggestedTargetId: number | null;
  sourceIdentity?: import("./quotation-source-match").SourceMatchItem | null;
  wordingChanged?: boolean;
  /** Source lines only: "exact" = identical item; "wording" = same printed wording, matched uniquely. */
  matchKind?: "exact" | "wording";
  /** Source lines matched by wording whose quantity, unit or prices differ in the replacement. */
  figuresChanged?: boolean;
}
export interface CarryForwardPreview {
  version: string;
  sourceId: number;
  targetId: number;
  blockedReason: string | null;
  setup: { key: typeof carrySetupKeys[number]; label: string; from: string; to: string; available: boolean }[];
  sourceLines: CarryLine[];
  targetLines: CarryLine[];
  header: { source: string; target: string; available: boolean };
  supportingPdfs: { id: number; label: string; fileName: string; alreadyPresent: boolean }[];
}

export interface ReplacementSummaryLine { id: number; lineNumber: number; description: string; totalHt: string; previousTotalHt?: string }
/** What changed between a replaced quotation and its replacement, by source item. */
export interface ReplacementReviewSummary {
  previousId: number; previousLabel: string;
  unchanged: ReplacementSummaryLine[]; figuresChanged: ReplacementSummaryLine[];
  added: ReplacementSummaryLine[]; removed: ReplacementSummaryLine[];
}
