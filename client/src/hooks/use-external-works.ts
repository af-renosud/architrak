import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, projectScopedKey } from "@/lib/queryClient";
import type { ExternalWorkForm, ExternalWorksResponse } from "@/lib/external-works";

export type ExternalWorkWrite =
  | { action: "create"; form: ExternalWorkForm; acknowledgeOverlap?: true }
  | { action: "edit"; id: number; version: number; form: ExternalWorkForm; acknowledgeOverlap?: true }
  | { action: "void"; id: number; version: number; reason: string }
  | { action: "restore"; id: number; version: number; acknowledgeOverlap?: true };

export function useExternalWorks(projectId: number) {
  return useQuery<ExternalWorksResponse>({
    queryKey: projectScopedKey(projectId, "external-works"),
  });
}

export function useWriteExternalWork(projectId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (write: ExternalWorkWrite) => {
      const base = `/api/projects/${projectId}/external-works`;
      if (write.action === "void") {
        await apiRequest("POST", `${base}/${write.id}/void`, { version: write.version, reason: write.reason.trim() });
      } else if (write.action === "restore") {
        await apiRequest("POST", `${base}/${write.id}/restore`, {
          version: write.version, ...(write.acknowledgeOverlap ? { acknowledgeOverlap: true } : {}),
        });
      } else {
        const { form } = write;
        await apiRequest(write.action === "create" ? "POST" : "PATCH",
          write.action === "create" ? base : `${base}/${write.id}`, {
            reference: form.reference.trim(),
            description: form.description.trim(),
            amountHt: form.amountHt,
            amountTtc: form.amountTtc,
            companyName: form.companyName.trim() || null,
            lot: form.lot.trim() || null,
            completionDate: form.completionDate || null,
            confirmedCompleted: true,
            ...(write.action === "edit" ? { version: write.version } : {}),
            ...(write.acknowledgeOverlap ? { acknowledgeOverlap: true } : {}),
          });
      }
    },
    onSuccess: () => {
      for (const resource of ["financial-summary", "external-works", "certificats"]) {
        void client.invalidateQueries({ queryKey: projectScopedKey(projectId, resource) });
      }
    },
  });
}
