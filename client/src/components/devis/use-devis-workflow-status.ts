import { useQuery } from "@tanstack/react-query";

/** Read the existing internal status payloads, not the outbound publication
 * gates. Editors remain lazy; a stale appendix warning must not be lazy. */
export function useDevisWorkflowStatus(devisId: number) {
  const analysis = useQuery<{ quotationChanged?: boolean; analysis: { status: string } | null }>({
    queryKey: ["/api/devis", devisId, "cost-analysis"],
  });
  const translation = useQuery<{ status: string; errorMessage?: string | null }>({
    queryKey: ["/api/devis", devisId, "translation"],
  });
  return { analysis, translation };
}
