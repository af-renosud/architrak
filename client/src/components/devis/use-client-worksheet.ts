import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { WorksheetComputation, WorksheetLineData } from "@shared/quotation-worksheet";

export interface WorksheetSummary {
  id: number; devisId: number; title: string; meetingDate: string | null; revision: number;
  duplicatedFromId: number | null; createdAt: string; updatedAt: string; createdBy: string | null;
}
export interface WorksheetDetail {
  worksheet: WorksheetSummary & { depositPercent: string | null };
  quotation: { id: number; code: string; number: string | null; date: string | null; projectId: number; projectName: string;
    projectCode: string | null; clientName: string | null; contractorName: string; amountHt: string; amountTtc: string };
  lines: WorksheetLineData[];
  computed: WorksheetComputation;
  readOnlyReason: string | null;
  history: Array<{ id: number; action: string; actor: string; at: string; reason: string | null; lineId: number | null;
    before: Record<string, unknown> | null; after: Record<string, unknown> | null }>;
}

export const worksheetListKey = (devisId: number) => ["/api/devis", devisId, "worksheets"];
export const worksheetKey = (id: number) => ["/api/worksheets", id];

export function useWorksheetList(devisId: number, enabled: boolean) {
  return useQuery<WorksheetSummary[]>({ queryKey: worksheetListKey(devisId), enabled });
}

/**
 * Loads one worksheet and serialises edits: each request reads the latest
 * revision at send time, so quick successive edits do not collide.
 * `flush` resolves once every queued edit has saved and rejects if the last
 * one failed, so exports never run ahead of (or silently past) an edit.
 */
export function useWorksheet(id: number | null, devisId: number) {
  const client = useQueryClient();
  const query = useQuery<WorksheetDetail>({ queryKey: worksheetKey(id ?? 0), enabled: id != null });
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [pending, setPending] = useState(0);
  const send = useCallback((method: "PATCH" | "POST" | "DELETE", path: string, body: Record<string, unknown> = {}) => {
    if (id == null) return Promise.reject(new Error("No worksheet open."));
    setPending(n => n + 1);
    const run = chain.current.catch(() => undefined).then(async () => {
      const current = client.getQueryData<WorksheetDetail>(worksheetKey(id));
      const res = await apiRequest(method, `/api/worksheets/${id}${path}`, { ...body, expectedRevision: current?.worksheet.revision });
      const detail = (await res.json()) as WorksheetDetail;
      client.setQueryData(worksheetKey(id), detail);
      client.invalidateQueries({ queryKey: worksheetListKey(devisId) });
      return detail;
    });
    chain.current = run;
    return run.finally(() => setPending(n => n - 1)).catch(error => {
      client.invalidateQueries({ queryKey: worksheetKey(id) });
      throw error;
    });
  }, [id, devisId, client]);

  /** Copies the worksheet into a new one, after pending edits have saved. */
  const duplicate = useCallback(async (title: string) => {
    if (id == null) throw new Error("No worksheet open.");
    await chain.current;
    const res = await apiRequest("POST", `/api/worksheets/${id}/duplicate`, { title });
    const detail = (await res.json()) as WorksheetDetail;
    client.setQueryData(worksheetKey(detail.worksheet.id), detail);
    client.invalidateQueries({ queryKey: worksheetListKey(devisId) });
    return detail;
  }, [id, devisId, client]);

  const flush = useCallback(async () => {
    const last = chain.current;
    try { await last; } catch (error) {
      if (chain.current === last) chain.current = Promise.resolve();
      throw error;
    }
  }, []);

  return { ...query, send, duplicate, flush, saving: pending > 0 };
}
