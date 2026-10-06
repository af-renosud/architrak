import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, ApiError, queryClient } from "@/lib/queryClient";
import { architectInvoiceKey, validateArchitectInvoice, type ArchitectInvoiceStatus } from "@/lib/architect-invoice";

export function useArchitectInvoice(certId: number) {
  return useQuery<ArchitectInvoiceStatus>({
    queryKey: architectInvoiceKey(certId),
    staleTime: 30_000,
  });
}

export function useArchitectInvoiceMutation(certId: number) {
  return useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) {
        await apiRequest("DELETE", `/api/certificats/${certId}/architect-invoice`);
        return;
      }
      const validation = validateArchitectInvoice(file);
      if (validation) throw new Error(validation);
      const body = new FormData();
      body.append("file", file);
      // apiRequest serializes JSON; multipart must preserve the browser boundary.
      const response = await fetch(`/api/certificats/${certId}/architect-invoice`, {
        method: "POST", credentials: "include", body,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new ApiError(response.status, data?.message ?? "Impossible de joindre la facture.", data);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: architectInvoiceKey(certId) }),
  });
}
