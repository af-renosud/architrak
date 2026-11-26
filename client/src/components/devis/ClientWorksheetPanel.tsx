import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ClientWorksheetEditor } from "./ClientWorksheetEditor";
import { useWorksheetList, worksheetKey, worksheetListKey, type WorksheetDetail } from "./use-client-worksheet";

const fmt = (v: string) => new Date(v).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "Europe/Paris" });

/**
 * Entry point on the quotation card: list this quotation's client worksheets
 * and create new ones. Worksheets are architect-only working copies.
 */
export function ClientWorksheetPanel({ devisId, isArchived, hasLines }: { devisId: number; isArchived: boolean; hasLines: boolean }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const { data: worksheets, isLoading } = useWorksheetList(devisId, expanded || openId != null);
  const { data: agreement } = useQuery<Record<number, { sharedRevision: number | null; unreadComments: number; lastRevisionRequestAt: string | null }>>({
    queryKey: ["/api/devis", devisId, "worksheets", "agreement-summary"], enabled: expanded || openId != null,
    // Client comments arrive from the client link: refetch on open and poll while visible.
    staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: true, refetchInterval: 60000,
  });

  const create = async () => {
    setCreating(true);
    try {
      const name = title.trim() || `Client meeting ${new Date().toLocaleDateString("en-GB", { timeZone: "Europe/Paris" })}`;
      const detail = (await (await apiRequest("POST", `/api/devis/${devisId}/worksheets`, { title: name })).json()) as WorksheetDetail;
      queryClient.setQueryData(worksheetKey(detail.worksheet.id), detail);
      queryClient.invalidateQueries({ queryKey: worksheetListKey(devisId) });
      setTitle("");
      setOpenId(detail.worksheet.id);
    } catch (e) {
      toast({ title: "Worksheet not created", description: (e as Error).message, variant: "destructive" });
    } finally { setCreating(false); }
  };

  return (
    <div className="rounded-md border bg-white p-3" data-testid={`panel-client-worksheets-${devisId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <FileSpreadsheet className="h-4 w-4 text-emerald-700" />
        <p className="text-xs font-semibold">Client worksheet</p>
        <p className="flex-1 text-[11px] text-muted-foreground">Amend quantities and prices with the client, compare with the original, and download an Excel version.</p>
        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setExpanded(v => !v)} data-testid={`button-toggle-worksheets-${devisId}`}>
          {expanded ? "Hide" : "Open"}
        </Button>
      </div>
      {expanded && (
        <div className="mt-2 space-y-2">
          {isLoading && <p className="text-[11px] text-muted-foreground">Loading…</p>}
          {worksheets?.length === 0 && <p className="text-[11px] text-muted-foreground">No worksheet yet.</p>}
          {worksheets?.map(w => (
            <button key={w.id} type="button" onClick={() => setOpenId(w.id)} data-testid={`button-open-worksheet-${w.id}`}
              className="flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] hover:bg-slate-50">
              <span className="font-medium">{w.title}</span>
              {w.meetingDate && <span className="text-muted-foreground">· meeting {fmt(w.meetingDate)}</span>}
              {agreement?.[w.id]?.sharedRevision != null && <span className="rounded-full bg-sky-50 px-1.5 text-[10px] text-sky-700" data-testid={`badge-worksheet-shared-${w.id}`}>
                Shared with client{agreement[w.id].sharedRevision !== w.revision ? " (older version)" : ""}</span>}
              {(agreement?.[w.id]?.unreadComments ?? 0) > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800" data-testid={`badge-worksheet-comments-${w.id}`}>
                {agreement![w.id].unreadComments} new client comment{agreement![w.id].unreadComments > 1 ? "s" : ""}</span>}
              {agreement?.[w.id]?.lastRevisionRequestAt && <span className="rounded-full bg-emerald-50 px-1.5 text-[10px] text-emerald-700">Revision requested {fmt(agreement[w.id].lastRevisionRequestAt!)}</span>}
              <span className="ml-auto text-muted-foreground">updated {fmt(w.updatedAt)}{w.createdBy ? ` · ${w.createdBy}` : ""}</span>
            </button>
          ))}
          {!isArchived && (
            hasLines ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input className="h-8 w-64 text-xs" placeholder="Name, e.g. Meeting 3 December" value={title} onChange={e => setTitle(e.target.value)} data-testid={`input-new-worksheet-title-${devisId}`} />
                <Button size="sm" className="h-8" onClick={create} disabled={creating} data-testid={`button-create-worksheet-${devisId}`}>
                  <Plus className="mr-1 h-3.5 w-3.5" />{creating ? "Preparing…" : "New worksheet from this quotation"}
                </Button>
              </div>
            ) : <p className="text-[11px] text-amber-800">This quotation has no extracted lines yet, so a worksheet cannot be prepared.</p>
          )}
          {isArchived && <p className="text-[11px] text-muted-foreground">Archived projects are read-only. Existing worksheets can still be viewed and downloaded.</p>}
        </div>
      )}
      <Dialog open={openId != null} onOpenChange={o => { if (!o) setOpenId(null); }}>
        <DialogContent className="flex h-[92vh] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 [&>button]:hidden">
          <DialogTitle className="sr-only">Client worksheet</DialogTitle>
          <DialogDescription className="sr-only">Editable client worksheet for this quotation</DialogDescription>
          {openId != null && <ClientWorksheetEditor worksheetId={openId} devisId={devisId} onClose={() => setOpenId(null)} onOpenWorksheet={setOpenId} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
