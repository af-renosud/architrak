import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/lib/queryClient";

/** Public metadata only. Object storage keys never belong in this payload. */
export interface SupportingPdf {
  id: number;
  label: string;
  fileName: string;
  pageCount: number;
  byteSize: number;
  position: number;
}

export const SUPPORTING_PDF_MAX_BYTES = 20 * 1024 * 1024;
export const supportingPdfsKey = (devisId: number) =>
  ["/api/devis", devisId, "supporting-pdfs"] as const;

export function validateSupportingPdf(file: File): string | null {
  if (!/\.pdf$/i.test(file.name)) return "Choose a PDF document.";
  if (!file.size) return "This file is empty. Choose a readable PDF.";
  if (file.size > SUPPORTING_PDF_MAX_BYTES) return "Each PDF must be 20 MB or smaller.";
  return null;
}

export function moveSupportingPdf(documents: SupportingPdf[], id: number, direction: -1 | 1): number[] {
  const ids = documents.map((document) => document.id);
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return ids;
}

type Action =
  | { kind: "upload"; file: File }
  | { kind: "rename"; id: number; label: string }
  | { kind: "reorder"; ids: number[] }
  | { kind: "remove"; id: number };

export function useSupportingPdfs(devisId: number) {
  const client = useQueryClient();
  const base = `/api/devis/${devisId}/supporting-pdfs`;
  const query = useQuery<SupportingPdf[]>({
    queryKey: supportingPdfsKey(devisId),
    queryFn: async () => (await apiRequest("GET", base)).json(),
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (action.kind === "upload") {
        const validationError = validateSupportingPdf(action.file);
        if (validationError) throw new Error(validationError);
        const form = new FormData();
        form.append("file", action.file);
        // Multipart uploads cannot use the JSON-only apiRequest helper.
        const response = await fetch(`${base}/upload`, {
          method: "POST", body: form, credentials: "include",
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({ message: "Upload failed. Please retry." }));
          throw new ApiError(response.status, body.message || "Upload failed.", body);
        }
      } else if (action.kind === "rename") {
        await apiRequest("PATCH", `${base}/${action.id}`, { label: action.label });
      } else if (action.kind === "reorder") {
        await apiRequest("POST", `${base}/reorder`, { ids: action.ids });
      } else {
        await apiRequest("DELETE", `${base}/${action.id}`);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: supportingPdfsKey(devisId) }),
        client.invalidateQueries({ queryKey: ["/api/devis", devisId, "translation"] }),
        client.invalidateQueries({
          predicate: ({ queryKey }) => queryKey.some((part) =>
            typeof part === "string" && /translation-readiness|client-portal/.test(part)),
        }),
      ]);
    },
  });
  return { ...query, documents: [...(query.data ?? [])].sort((a, b) => a.position - b.position || a.id - b.id), mutation };
}