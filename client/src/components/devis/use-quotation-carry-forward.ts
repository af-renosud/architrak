import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { isContextDocEmpty } from "@shared/context-doc";
import type { CarryForwardPreview, CarryForwardSelection, CarryLine } from "@shared/quotation-carry-forward";
import { invalidateQuotationReplacement } from "./use-quotation-replacement";

export const hasLineContext = (line: CarryLine) => !isContextDocEmpty(line.context) || line.imageCount > 0;
export const hasLineTranslation = (line: CarryLine) => !!line.translation?.trim();

export function suggestedCarrySelection(preview: CarryForwardPreview): CarryForwardSelection {
  const used = new Set<number>();
  return {
    version: preview.version, setup: [], header: false, supportingPdfIds: [],
    lines: preview.sourceLines.flatMap(source => {
      const target = preview.targetLines.find(line => line.id === source.suggestedTargetId);
      // Only the server's unique, exact, unchanged suggestions may be preselected.
      if (!target || used.has(target.id)) return [];
      used.add(target.id);
      return [{
        sourceLineId: source.id, targetLineId: target.id,
        context: hasLineContext(source) && !hasLineContext(target),
        translation: hasLineTranslation(source) && !hasLineTranslation(target),
      }];
    }),
  };
}

export function selectedCarryWork(selection: CarryForwardSelection): CarryForwardSelection {
  return { ...selection, lines: selection.lines.filter(line => line.context || line.translation) };
}

export function hasCarryWork(selection: CarryForwardSelection | null | undefined): boolean {
  return !!selection && (!!selection.setup.length || selection.header || !!selection.supportingPdfIds.length
    || selection.lines.some(line => line.context || line.translation));
}

export function useQuotationCarryForward(sourceId: number, targetId: number | null) {
  const preview = useQuery<CarryForwardPreview>({
    queryKey: ["/api/devis", sourceId, "carry-forward", targetId],
    queryFn: async () => (await apiRequest("GET", `/api/devis/${sourceId}/carry-forward?targetId=${targetId}`)).json(),
    enabled: targetId !== null,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const [edited, setEdited] = useState<{ sourceId: number; targetId: number; selection: CarryForwardSelection } | null>(null);
  const data = preview.data;
  const selection = data
    ? edited?.sourceId === sourceId && edited.targetId === targetId && edited.selection.version === data.version
      ? edited.selection : suggestedCarrySelection(data)
    : null;
  return {
    preview, selection,
    setSelection: (value: CarryForwardSelection) => { if (targetId !== null) setEdited({ sourceId, targetId, selection: value }); },
    reload: async () => { setEdited(null); return preview.refetch(); },
  };
}

export function invalidateQuotationCarryForward(projectId: string, sourceId: number, targetId: number) {
  invalidateQuotationReplacement(projectId);
  // Include both segmented and single-URL keys used by detail/translation surfaces.
  void queryClient.invalidateQueries({
    predicate: query => query.queryKey.some(part => typeof part === "string" &&
      [sourceId, targetId].some(id => part === `/api/devis/${id}` || part.startsWith(`/api/devis/${id}/`)))
      || (query.queryKey[0] === "/api/devis" && [String(sourceId), String(targetId)].includes(String(query.queryKey[1]))),
  });
}
