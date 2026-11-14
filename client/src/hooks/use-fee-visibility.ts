import { useMutation, useQuery } from "@tanstack/react-query";
import type { FeeRecordKind, FeeVisibilityResponse } from "@shared/fee-visibility";
import { apiRequest, queryClient } from "@/lib/queryClient";

export function invalidateFeeReads(projectId: string) {
  for (const resource of ["fees", "fee-entries", "fee-visibility", "design-contract"]) {
    void queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), resource] });
  }
  void queryClient.invalidateQueries({ queryKey: ["/api/fees/outstanding"] });
}
export function useFeeVisibility(projectId: string) {
  return useQuery<FeeVisibilityResponse>({
    queryKey: ["/api/projects", String(projectId), "fee-visibility"],
    enabled: !!projectId,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/projects/${projectId}/fee-visibility`);
      const data = await response.json() as FeeVisibilityResponse;
      if (!Array.isArray(data.records) || !Array.isArray(data.events) || data.records.some(record =>
        (record.kind !== "fee" && record.kind !== "entry") || typeof record.id !== "number" || typeof record.archived !== "boolean"
      )) {
        throw new Error("Visibility API returned incomplete data. No archive states have been inferred.");
      }
      return data;
    },
  });
}
export function useChangeFeeVisibility(projectId: string) {
  return useMutation({
    mutationFn: async (data: { kind: FeeRecordKind; id: number; action: "archive" | "restore"; reason: string }) => {
      const response = await apiRequest("POST", `/api/projects/${projectId}/fee-visibility/${data.kind}/${data.id}`, {
        action: data.action, reason: data.reason.trim(),
      });
      return response.json() as Promise<FeeVisibilityResponse>;
    },
    onSuccess: response => {
      queryClient.setQueryData(["/api/projects", String(projectId), "fee-visibility"], response);
      invalidateFeeReads(projectId);
    },
  });
}
