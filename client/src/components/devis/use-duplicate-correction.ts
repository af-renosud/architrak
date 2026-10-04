import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, projectScopedKey } from "@/lib/queryClient";

const previewLine = z.object({
  id: z.number(),
  lineNumber: z.number(),
  description: z.string(),
  totalHt: z.string(),
});
const previewSchema = z.object({
  removeLine: previewLine,
  retainLine: previewLine,
  beforeSumHt: z.string(),
  afterSumHt: z.string(),
  sourceTotalHt: z.string(),
  discrepancyBeforeHt: z.string(),
  discrepancyAfterHt: z.string(),
  fingerprint: z.string().min(1),
  blockedReason: z.string().nullable(),
});
export type DuplicateCorrectionPreview = z.infer<typeof previewSchema>;

export function useDuplicateCorrection(
  devisId: number,
  projectId: string,
  removeLineId: number,
  retainLineId: number | null,
  enabled: boolean,
) {
  const client = useQueryClient();
  const preview = useQuery({
    queryKey: ["/api/devis", devisId, "duplicate-correction-preview", removeLineId, retainLineId],
    enabled: enabled && retainLineId !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const params = new URLSearchParams({
        removeLineId: String(removeLineId),
        retainLineId: String(retainLineId),
      });
      const res = await apiRequest("GET", `/api/devis/${devisId}/duplicate-correction-preview?${params}`);
      const result = previewSchema.parse(await res.json());
      if (result.removeLine.id !== removeLineId || result.retainLine.id !== retainLineId) {
        throw new Error("The preview does not match the selected lines. Please retry.");
      }
      return result;
    },
  });
  const correction = useMutation({
    retry: false,
    mutationFn: async (data: { removeLineId: number; retainLineId: number; reason: string; fingerprint: string }) => {
      await apiRequest("POST", `/api/devis/${devisId}/duplicate-corrections`, data);
    },
    onSuccess: () => {
      // Includes duplicate-corrections history (even while collapsed), line items,
      // translations, context, checks and cached quotation data.
      void client.invalidateQueries({ queryKey: ["/api/devis", devisId] });
      void client.invalidateQueries({ queryKey: projectScopedKey(projectId) });
    },
  });
  return { preview, correction };
}