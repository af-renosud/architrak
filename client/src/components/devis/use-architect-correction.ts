import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, projectScopedKey } from "@/lib/queryClient";
import type { ArchitectBaselineConfirmation, ArchitectCorrectionSave, ArchitectCorrectionSnapshot } from "./architect-correction-model";
import type { DevisTranslationHeader, DevisTranslationLine } from "@shared/schema";

export const architectCorrectionKey = (devisId: number) => ["/api/devis", devisId, "architect-correction"] as const;
export function useArchitectCorrection(devisId: number, projectId: string, enabled: boolean) {
  const client = useQueryClient();
  const endpoint = `/api/devis/${devisId}/architect-correction`;
  const snapshot = useQuery<ArchitectCorrectionSnapshot>({
    queryKey: architectCorrectionKey(devisId),
    enabled,
    queryFn: async () => (await apiRequest("GET", endpoint)).json(),
    retry: false,
  });
  const publish = (next: ArchitectCorrectionSnapshot) => {
    client.setQueryData(architectCorrectionKey(devisId), next);
    // Do not re-initialise a local draft on background invalidation.
    void client.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-items"] });
    void client.invalidateQueries({ queryKey: ["/api/devis", devisId], exact: true });
    void client.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] });
    void client.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-contexts"] });
    void client.invalidateQueries({ queryKey: projectScopedKey(projectId) });
    void client.invalidateQueries({ queryKey: ["/api/dashboard/summary"] });
  };
  const save = useMutation<ArchitectCorrectionSnapshot, Error, ArchitectCorrectionSave>({
    mutationFn: async (data) => (await apiRequest("PUT", endpoint, data)).json(),
    retry: false,
    onSuccess: publish,
  });
  const baseline = useMutation<ArchitectCorrectionSnapshot, Error, ArchitectBaselineConfirmation>({
    mutationFn: async (data) => (await apiRequest("POST", `${endpoint}/source-baseline`, data)).json(),
    retry: false,
    onSuccess: publish,
  });
  const suggest = useMutation<{ expectedVersion: string; suggestion: { header: DevisTranslationHeader; lines: DevisTranslationLine[] } }, Error, ArchitectCorrectionSave>({
    mutationFn: async (data) => (await apiRequest("POST", `${endpoint}/translation-suggestions`, data)).json(),
    retry: false,
  });
  return { snapshot, save, baseline, suggest };
}
