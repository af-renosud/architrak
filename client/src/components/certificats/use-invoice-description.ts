import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export function invoiceDescriptionKey(certId: number) {
  return ["/api/certificats", String(certId), "invoice-description"];
}

export function useInvoiceDescription(certId: number) {
  return useQuery<{ description: string }>({
    queryKey: invoiceDescriptionKey(certId),
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/certificats/${certId}/invoice-description`);
      const data = await response.json();
      if (typeof data?.description !== "string" || !data.description.trim()) {
        throw new Error("La description reçue est vide ou invalide.");
      }
      return data;
    },
    refetchOnMount: "always",
    retry: false,
  });
}
