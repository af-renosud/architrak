import { useQuery } from "@tanstack/react-query";
import type { DuplicateExtractionHistoryEntry } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";

export const duplicateExtractionHistoryKey = (devisId: number) =>
  ["/api/devis", devisId, "duplicate-corrections"] as const;

export function useDuplicateExtractionHistory(devisId: number, open: boolean) {
  return useQuery<DuplicateExtractionHistoryEntry[]>({
    queryKey: duplicateExtractionHistoryKey(devisId),
    enabled: open,
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/devis/${devisId}/duplicate-corrections`);
      return response.json();
    },
  });
}