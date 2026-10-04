import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, projectScopedKey } from "@/lib/queryClient";

const rowSchema = z.object({
  lineNumber: z.number().int(),
  description: z.string(),
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
  unitPriceHt: z.string().nullable(),
  totalHt: z.string(),
});
const previewSchema = z.object({
  fingerprint: z.string().min(1),
  blockedReason: z.string().nullable(),
  before: rowSchema.nullable(),
  after: rowSchema,
  beforeSumHt: z.string(),
  afterSumHt: z.string(),
  sourceTotalHt: z.string(),
  sourceTotalTtc: z.string(),
  discrepancyBeforeHt: z.string(),
  discrepancyAfterHt: z.string(),
});
export type ExtractionRow = z.infer<typeof rowSchema>;
export type ExtractionRowPreview = z.infer<typeof previewSchema>;
export interface ExtractionRowRequest {
  kind: "missing" | "misread";
  lineId?: number;
  row: ExtractionRow;
  evidence: { page: number; excerpt: string };
  reason: string;
}

export function useExtractionRowCorrection(devisId: number, projectId: string) {
  const client = useQueryClient();
  const preview = useMutation({
    retry: false,
    mutationFn: async (data: ExtractionRowRequest) => {
      const response = await apiRequest("POST", `/api/devis/${devisId}/extraction-correction-preview`, data);
      return previewSchema.parse(await response.json());
    },
  });
  const correction = useMutation({
    retry: false,
    mutationFn: async (data: ExtractionRowRequest & { fingerprint: string; confirmed: true }) => {
      await apiRequest("POST", `/api/devis/${devisId}/extraction-corrections`, data);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["/api/devis", devisId] });
      void client.invalidateQueries({ queryKey: projectScopedKey(projectId) });
    },
  });
  return { preview, correction };
}