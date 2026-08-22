import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Download, ExternalLink, FileCheck2, FilePlus2, FileText, Info, Loader2, LockKeyhole, Pencil, Plus, RefreshCw, ShieldCheck, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Amount } from "@/components/ui/amount";
import { apiRequest, projectScopedKey, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type Line = { id?: number; lineNumber: number; description: string; quantity: string; unit: string; unitPriceHt: string; totalHt: string; pdfPageHint?: number | null };
type TechnicalLot = { id: string; code: string; labelFr: string; displayOrder: number; isActive: boolean; deletedAt: string | null };
type Revision = { revision: { id: number; status: "draft" | "reviewed" | "approved" | "superseded"; reference: string; descriptionFr: string; documentDate?: string | null; amountHt: string; amountTtc: string; tvaRatePercent?: string | null; tvaAutoliquidation?: boolean; version: number; contractorId?: number | null; lotId?: number | null; archidocTechnicalLotId?: string | null; supersedesRevisionId?: number | null; promotedDevisId?: number | null; promotedAt?: string | null; updatedAt: string }; lines: Line[]; source: { sourceKind: "manual" | "pdf_upload"; fileName?: string | null; confidence?: number | null; warnings?: { message?: string; severity?: string }[]; requiresVerification?: boolean; verifiedAt?: string | null; verificationNote?: string | null } | null; contractorName: string | null; lotNumber: string | null; technicalLot: TechnicalLot | null; legacyLotNeedsReview?: boolean };
type PlanningImport = { id: number; fileName: string; status: "processing" | "succeeded" | "failed" | "stale"; stage: "accepted" | "extracting" | "validating" | "storing" | "saving" | "complete"; revisionId: number | null; errorCode: string | null; errorMessage: string | null; startedAt: string; updatedAt: string; completedAt: string | null };
type EnvelopeResponse = { envelope: { currency: string } | null; revisions: Revision[]; imports?: PlanningImport[]; totals: { amountHt: string; amountTtc: string; byLot: { lotId: number | null; archidocTechnicalLotId?: string | null; lotNumber: string | null; description: string; amountHt: string; amountTtc: string; count: number }[] } };
type TechnicalLotsResponse = { lots: TechnicalLot[]; catalogue: { revision: number; changedAt: string; syncedAt?: string } | null; sync: { status: string; errorMessage?: string | null } | null };
type Choice = {
  id: number;
  name?: string;
  companyName?: string;
  lotNumber?: string;
  descriptionFr?: string;
  archidocPartnerType?: string | null;
  archidocOrphanedAt?: string | Date | null;
};

const euro = (value: string | number) => Number(value || 0);
const dateLabel = (value?: string | null) => value ? new Date(value).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const dateTimeLabel = (value?: string | number | null) => value ? new Date(value).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const stateLabels: Record<string, string> = { draft: "Draft", reviewed: "Reviewed", approved: "Approved", superseded: "Superseded" };
const stateClasses: Record<string, string> = { draft: "bg-slate-100 text-slate-700", reviewed: "bg-amber-100 text-amber-800", approved: "bg-emerald-100 text-emerald-800", superseded: "bg-stone-100 text-stone-500" };
const importStageLabels: Record<PlanningImport["stage"], string> = { accepted: "Upload accepted", extracting: "Reading and extracting the PDF", validating: "Checking the extracted data", storing: "Saving the source PDF", saving: "Creating the planning draft", complete: "Ready for review" };

const TECHNICAL_LOTS_KEY = ["/api/archidoc/technical-lots"];

interface Props { projectId: string; contractors: Choice[]; isArchived: boolean; }

export function PlanningEnvelopeTab({ projectId, contractors, isArchived }: Props) {
  const { toast } = useToast();
  const [dialog, setDialog] = useState<"new" | "edit" | "review" | null>(null);
  const [editing, setEditing] = useState<Revision | null>(null);
  const [promote, setPromote] = useState<Revision | null>(null);
  const [verificationNote, setVerificationNote] = useState("");
  const [localImport, setLocalImport] = useState<{ fileName: string; startedAt: string } | null>(null);
  const [technicalLotsRetrying, setTechnicalLotsRetrying] = useState(false);
  const importing = localImport != null;
  const fileRef = useRef<HTMLInputElement>(null);
  const key = projectScopedKey(projectId, "planning-envelope");
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery<EnvelopeResponse>({
    queryKey: key,
    refetchInterval: (query) => {
      const serverHasActiveImport = query.state.data?.imports?.some((item) => item.status === "processing") === true;
      return importing || serverHasActiveImport ? 3000 : false;
    },
  });

  // Query technical lots catalogue from Archidoc mirror
  const {
    data: technicalLotsData,
    error: technicalLotsError,
    isFetching: technicalLotsFetching,
    refetch: technicalLotsRefetch,
    isStale: technicalLotsIsStale,
  } = useQuery<TechnicalLotsResponse>({
    queryKey: TECHNICAL_LOTS_KEY,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const retryTechnicalLots = async () => {
    setTechnicalLotsRetrying(true);
    try {
      const response = await apiRequest("POST", "/api/archidoc/sync", {});
      const result = await response.json() as { technicalLots?: { error?: string } };
      if (result.technicalLots?.error) throw new Error(result.technicalLots.error);
      await technicalLotsRefetch();
    } catch (retryError) {
      toast({
        title: "Lot catalogue could not be refreshed",
        description: retryError instanceof Error ? retryError.message : "Try again later.",
        variant: "destructive",
      });
      await technicalLotsRefetch();
    } finally {
      setTechnicalLotsRetrying(false);
    }
  };

  const invalidate = () => { queryClient.invalidateQueries({ queryKey: key }); queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "devis") }); };
  const action = useMutation({
    mutationFn: async ({ url, body }: { url: string; body?: unknown }) => { const response = await apiRequest("POST", url, body); return response.json(); },
    onSuccess: () => { invalidate(); setDialog(null); setEditing(null); setPromote(null); setVerificationNote(""); toast({ title: "Planning envelope updated" }); },
    onError: (e: Error) => toast({ title: "Action could not be completed", description: e.message, variant: "destructive" }),
  });
  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: unknown }) => { const response = await apiRequest("PATCH", `/api/planning-revisions/${id}`, body); return response.json(); },
    onSuccess: () => { invalidate(); setDialog(null); setEditing(null); toast({ title: "Revision saved" }); },
    onError: (e: Error) => toast({ title: "Revision could not be saved", description: e.message, variant: "destructive" }),
  });
  const importPdf = async (file: File) => {
    setLocalImport({ fileName: file.name, startedAt: new Date().toISOString() });
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch(`/api/projects/${projectId}/planning-envelope/import`, { method: "POST", body: form, credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? `PDF import failed (${response.status})`);
      }
      const extracted = await response.json(); invalidate();
      const revision = extracted?.revision ? { revision: extracted.revision, lines: extracted.lines ?? [], source: extracted.source ?? null, contractorName: extracted.contractorName ?? null, lotNumber: extracted.lotNumber ?? null, technicalLot: extracted.technicalLot ?? null } : (extracted?.id ? { revision: extracted, lines: extracted.lines ?? [], source: extracted.source ?? null, contractorName: extracted.contractorName ?? null, lotNumber: extracted.lotNumber ?? null, technicalLot: extracted.technicalLot ?? null } : null);
      if (revision) { setEditing(revision); setDialog("edit"); }
      toast({ title: "PDF imported", description: "The extracted draft is ready for review." });
    } catch (e) { toast({ title: "PDF import failed", description: (e as Error).message, variant: "destructive" }); }
    finally {
      await queryClient.invalidateQueries({ queryKey: key });
      setLocalImport(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const totals = data?.totals;
  const openImportedRevision = (revisionId: number) => {
    const revision = data?.revisions.find((item) => item.revision.id === revisionId);
    if (revision) {
      setEditing(revision);
      setDialog("edit");
    } else {
      void refetch();
    }
  };

  if (isLoading) return <div data-testid="panel-planning-envelope" className="space-y-3"><LuxuryCard><div className="animate-pulse space-y-3"><div className="h-4 w-44 rounded bg-muted" /><div className="h-12 w-full rounded bg-muted" /><div className="h-20 w-full rounded bg-muted" /></div></LuxuryCard></div>;
  if (error) return <LuxuryCard data-testid="planning-envelope-error"><div className="flex items-center gap-3 text-destructive"><AlertTriangle size={16} /><div><p className="text-sm font-semibold">Planning envelope unavailable</p><p className="text-xs text-muted-foreground mt-1">Could not load the planning record.</p></div><Button variant="outline" size="sm" className="ml-auto" onClick={() => refetch()} data-testid="planning-envelope-retry">Retry</Button></div></LuxuryCard>;

  return (
    <div className="space-y-4" data-testid="panel-planning-envelope">
      {isArchived && <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="planning-envelope-archived-banner"><LockKeyhole size={14} className="mt-0.5 shrink-0" /><span><strong>Archived project — read-only.</strong> Planning records remain available for audit; imports and workflow changes are disabled.</span></div>}
      <div className="flex items-start justify-between gap-3 flex-wrap border-l-2 border-[#b9784c] pl-4">
        <div><TechnicalLabel>Planning Envelope · internal working record</TechnicalLabel><h2 className="mt-1 text-xl font-light tracking-tight">Budget before commitment</h2><p className="text-xs text-muted-foreground mt-1 max-w-2xl">Candidate amounts stay separate from contractual Live Delivery until explicitly promoted.</p></div>
        <div className="flex gap-2 flex-wrap">
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => e.target.files?.[0] && importPdf(e.target.files[0])} />
          <Button variant="ghost" size="sm" disabled={isFetching} onClick={() => void refetch()} data-testid="planning-envelope-refresh-status">
            <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} /> Refresh status
          </Button>
          <Button variant="outline" size="sm" disabled={isArchived || importing} onClick={() => fileRef.current?.click()} data-testid="planning-envelope-import">
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} {importing ? "Processing PDF…" : "Import PDF"}
          </Button>
          <Button size="sm" disabled={isArchived} onClick={() => { setEditing(null); setDialog("new"); }} data-testid="planning-envelope-new"><Plus size={13} /> New revision</Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground" data-testid="planning-envelope-last-refreshed">
        <span>{dataUpdatedAt ? `Status checked ${dateTimeLabel(dataUpdatedAt)}` : "Status not checked yet"}</span>
        {(importing || data?.imports?.some((item) => item.status === "processing")) && <span className="inline-flex items-center gap-1 text-[#9a5c36]"><Loader2 size={11} className="animate-spin" /> Refreshing automatically</span>}
      </div>
      <PlanningImportStatus
        imports={data?.imports ?? []}
        localImport={localImport}
        revisions={data?.revisions ?? []}
        isArchived={isArchived}
        onOpenRevision={openImportedRevision}
        onChooseFile={() => fileRef.current?.click()}
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2" data-testid="planning-envelope-totals">
        <LuxuryCard className="p-4 border-[#d5b8a4] bg-[#fbf7f3]"><TechnicalLabel>Planned HT</TechnicalLabel><p className="mt-2 text-lg font-light"><Amount value={euro(totals?.amountHt ?? "0")} denomination="HT" /></p></LuxuryCard>
        <LuxuryCard className="p-4 border-[#d5b8a4] bg-[#fbf7f3]"><TechnicalLabel>Planned TTC</TechnicalLabel><p className="mt-2 text-lg font-light"><Amount value={euro(totals?.amountTtc ?? "0")} denomination="TTC" /></p></LuxuryCard>
        <LuxuryCard className="col-span-2 p-4"><TechnicalLabel>Envelope status</TechnicalLabel><p className="mt-2 text-sm">{data?.envelope ? <><span className="font-semibold text-emerald-700">Active</span><span className="text-muted-foreground"> · {data.revisions.length} revision{data.revisions.length === 1 ? "" : "s"}</span></> : <span className="text-muted-foreground">No planning envelope yet</span>}</p></LuxuryCard>
      </div>
      {totals?.byLot?.length ? <LuxuryCard className="p-4"><div className="flex items-center justify-between mb-3"><TechnicalLabel>Planned amounts by lot</TechnicalLabel><span className="text-[10px] text-muted-foreground">HT / TTC</span></div><div className="grid gap-2 sm:grid-cols-2">{totals.byLot.map((lot) => {
        const lotLabel = lot.lotNumber ? `${lot.lotNumber} · ` : "";
        return <div key={`${lot.archidocTechnicalLotId ?? lot.lotId}-${lot.description}`} className="flex justify-between gap-3 rounded-lg border border-border/70 px-3 py-2 text-xs"><div className="min-w-0"><p className="font-semibold truncate">{lotLabel}{lot.description}</p><p className="text-[10px] text-muted-foreground">{lot.count} candidate{lot.count === 1 ? "" : "s"}</p></div><div className="text-right whitespace-nowrap"><p><Amount value={euro(lot.amountHt)} denomination="HT" /></p><p className="text-muted-foreground"><Amount value={euro(lot.amountTtc)} denomination="TTC" /></p></div></div>;
      })}</div></LuxuryCard> : null}
      {!data?.revisions?.length ? <LuxuryCard className="py-12 text-center" data-testid="planning-envelope-empty"><FilePlus2 size={23} className="mx-auto text-[#b9784c]" /><p className="mt-3 text-sm font-semibold">No planning candidates yet</p><p className="mt-1 text-xs text-muted-foreground">Create a revision manually or import a contractor PDF to establish the first working envelope.</p></LuxuryCard> :
        <div className="space-y-3">{data.revisions.map((item) => <RevisionCard key={item.revision.id} item={item} revisions={data.revisions} projectId={projectId} isArchived={isArchived} onEdit={() => { setEditing(item); setDialog("edit"); }} onReview={() => { setEditing(item); setDialog("review"); }} onAction={(url, body) => action.mutate({ url, body })} onPromote={() => setPromote(item)} />)}</div>}
      <RevisionDialog open={dialog === "new" || dialog === "edit"} item={dialog === "edit" ? editing : null} contractors={contractors} technicalLotsData={technicalLotsData} technicalLotsError={technicalLotsError} technicalLotsFetching={technicalLotsFetching || technicalLotsRetrying} technicalLotsIsStale={technicalLotsIsStale} onTechnicalLotsRetry={() => void retryTechnicalLots()} pending={patch.isPending || action.isPending} onClose={() => { setDialog(null); setEditing(null); }} onSubmit={(body) => dialog === "edit" && editing ? patch.mutate({ id: editing.revision.id, body: { ...(body as Record<string, unknown>), expectedVersion: editing.revision.version } }) : action.mutate({ url: `/api/projects/${projectId}/planning-envelope/revisions`, body })} />
      <Dialog open={dialog === "review"} onOpenChange={(v) => !v && setDialog(null)}><DialogContent className="max-w-md" data-testid="planning-envelope-review-dialog"><DialogHeader><DialogTitle>Review planning revision</DialogTitle><DialogDescription>Confirm that the extracted amounts and line items have been checked against the source.</DialogDescription></DialogHeader>{editing?.source?.requiresVerification ? <p className="text-xs text-amber-800 rounded border border-amber-200 bg-amber-50 p-2">A verification note of at least 10 characters is required for this extracted source.</p> : <p className="text-xs text-muted-foreground">A verification note is optional for manual or high-confidence entries.</p>}<Textarea value={verificationNote} onChange={(e) => setVerificationNote(e.target.value)} placeholder={editing?.source?.requiresVerification ? "Describe what you verified (minimum 10 characters)" : "Verification note (optional)"} data-testid="planning-envelope-verification-note" /><Button disabled={action.isPending || (!!editing?.source?.requiresVerification && verificationNote.trim().length < 10)} onClick={() => editing && action.mutate({ url: `/api/planning-revisions/${editing.revision.id}/review`, body: { expectedVersion: editing.revision.version, ...(verificationNote ? { verificationNote } : {}) } })} data-testid="planning-envelope-review-confirm"><ShieldCheck size={13} /> Confirm review</Button></DialogContent></Dialog>
      <AlertDialog open={!!promote} onOpenChange={(v) => !v && setPromote(null)}><AlertDialogContent data-testid="planning-envelope-promote-dialog"><AlertDialogHeader><AlertDialogTitle>Promote this revision to Live Delivery?</AlertDialogTitle><AlertDialogDescription>This creates a new provisional Live devis from the approved planning revision. The planning record remains unchanged and can still be audited.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep in planning</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={action.isPending} onClick={() => promote && action.mutate({ url: `/api/planning-revisions/${promote.revision.id}/promote`, body: { expectedVersion: promote.revision.version } })} data-testid="planning-envelope-promote-confirm">Create provisional devis</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}

function PlanningImportStatus({ imports, localImport, revisions, isArchived, onOpenRevision, onChooseFile }: { imports: PlanningImport[]; localImport: { fileName: string; startedAt: string } | null; revisions: Revision[]; isArchived: boolean; onOpenRevision: (revisionId: number) => void; onChooseFile: () => void }) {
  const hasMatchingServerImport = !!localImport && imports.some((item) => item.status === "processing" && item.fileName === localImport.fileName);
  const visibleImports = imports.slice(0, 6);
  const showLocal = !!localImport && !hasMatchingServerImport;
  if (!showLocal && visibleImports.length === 0) return null;

  return <LuxuryCard className="p-4" data-testid="planning-import-status">
    <div className="flex items-start justify-between gap-3 mb-3">
      <div><TechnicalLabel>Recent PDF imports</TechnicalLabel><p className="text-[11px] text-muted-foreground mt-1">Processing continues if you leave this tab. Completed drafts remain linked here.</p></div>
      {(showLocal || visibleImports.some((item) => item.status === "processing")) && <Badge className="bg-amber-100 text-amber-800 text-[10px]">In progress</Badge>}
    </div>
    <div className="space-y-2" aria-live="polite">
      {showLocal && <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2" data-testid="planning-import-local">
        <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-amber-700" />
        <div className="min-w-0"><p className="text-xs font-semibold truncate" title={localImport.fileName}>{localImport.fileName}</p><p className="text-[11px] text-amber-800 mt-0.5">Sending PDF to the server</p><p className="text-[10px] text-muted-foreground mt-1">Started {dateTimeLabel(localImport.startedAt)}</p></div>
      </div>}
      {visibleImports.map((item) => {
        const isActive = item.status === "processing";
        const isSuccess = item.status === "succeeded";
        const revisionAvailable = item.revisionId != null && revisions.some((revision) => revision.revision.id === item.revisionId);
        return <div key={item.id} className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border px-3 py-2 ${isActive ? "border-amber-200 bg-amber-50/70" : isSuccess ? "border-emerald-200 bg-emerald-50/60" : "border-rose-200 bg-rose-50/60"}`} data-testid={`planning-import-${item.id}`}>
          <div className="flex items-start gap-3 min-w-0 flex-1">
            {isActive ? <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-amber-700" /> : isSuccess ? <Check size={15} className="mt-0.5 shrink-0 text-emerald-700" /> : <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-700" />}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap"><p className="text-xs font-semibold truncate max-w-[36rem]" title={item.fileName}>{item.fileName}</p><Badge className={`text-[9px] ${isActive ? "bg-amber-100 text-amber-800" : isSuccess ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>{isActive ? "Processing" : isSuccess ? "Ready for review" : item.status === "stale" ? "Stopped" : "Failed"}</Badge></div>
              <p className={`text-[11px] mt-0.5 ${isActive ? "text-amber-800" : isSuccess ? "text-emerald-800" : "text-rose-800"}`}>{isActive || isSuccess ? importStageLabels[item.stage] : item.errorMessage ?? "PDF import did not complete."}</p>
              <p className="text-[10px] text-muted-foreground mt-1">Started {dateTimeLabel(item.startedAt)} · Updated {dateTimeLabel(item.updatedAt)}</p>
            </div>
          </div>
          {isSuccess && item.revisionId != null && <Button variant="outline" size="sm" disabled={!revisionAvailable} onClick={() => onOpenRevision(item.revisionId!)} data-testid={`planning-import-open-${item.id}`}><Pencil size={12} /> Review draft</Button>}
          {!isActive && !isSuccess && <Button variant="outline" size="sm" disabled={isArchived} onClick={onChooseFile} data-testid={`planning-import-retry-${item.id}`}><Upload size={12} /> Choose PDF again</Button>}
        </div>;
      })}
    </div>
  </LuxuryCard>;
}

function RevisionCard({ item, revisions, projectId, isArchived, onEdit, onReview, onAction, onPromote }: { item: Revision; revisions: Revision[]; projectId: string; isArchived: boolean; onEdit: () => void; onReview: () => void; onAction: (url: string, body?: unknown) => void; onPromote: () => void }) {
  const r = item.revision;
  const immutable = r.status === "approved" || r.status === "superseded";
  const canRevise = r.status === "approved";
  const canApprove = r.status === "reviewed";
  const sourceWarnings = item.source?.warnings ?? [];
  const prior = r.supersedesRevisionId ? revisions.find((candidate) => candidate.revision.id === r.supersedesRevisionId) : undefined;
  const variance = prior ? Number(r.amountHt) - Number(prior.revision.amountHt) : null;
  const variancePct = prior && Number(prior.revision.amountHt) !== 0 ? (variance! / Number(prior.revision.amountHt)) * 100 : null;

  // Lot display: prefer technicalLot data, fall back to legacy lotNumber
  const lotDisplay = item.technicalLot
    ? `${item.technicalLot.code} — ${item.technicalLot.labelFr}`
    : item.lotNumber
      ? `Lot ${item.lotNumber}`
      : "Lot not assigned";

  return <LuxuryCard className={`p-4 ${immutable ? "bg-muted/20" : ""}`} data-testid={`planning-envelope-revision-${r.id}`}>
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2 flex-wrap"><FileText size={15} className="text-[#9a5c36]" /><span className="font-semibold text-sm">{r.reference || "Unreferenced revision"}</span><Badge className={`text-[10px] ${stateClasses[r.status]}`}>{stateLabels[r.status]}</Badge>{immutable && <LockKeyhole size={12} className="text-muted-foreground" />}</div><p className="text-xs text-muted-foreground mt-1 truncate">{r.descriptionFr || "No scope description"} · {item.contractorName ?? "Contractor not assigned"} · {lotDisplay}</p></div><div className="text-right whitespace-nowrap"><p className="font-semibold text-sm"><Amount value={euro(r.amountHt)} denomination="HT" /></p><p className="text-[10px] text-muted-foreground"><Amount value={euro(r.amountTtc)} denomination="TTC" /></p></div></div>
    <div className="mt-3 flex items-center gap-3 flex-wrap text-[10px] text-muted-foreground"><span>v{r.version}</span><span>{r.documentDate ? `Document ${dateLabel(r.documentDate)}` : `Updated ${dateLabel(r.updatedAt)}`}</span><span>{item.source?.sourceKind === "pdf_upload" ? `PDF · ${item.source.fileName ?? "source file"}` : "Manual entry"}</span>{item.source?.confidence != null && <span>Confidence {item.source.confidence}%</span>}{item.source?.requiresVerification && <span className="text-amber-700 flex items-center gap-1"><AlertTriangle size={11} /> Verification required</span>}{item.legacyLotNeedsReview && <span className="text-amber-700 flex items-center gap-1" data-testid={`planning-envelope-legacy-lot-review-${r.id}`}><AlertTriangle size={11} /> Legacy lot needs review</span>}</div>
    {sourceWarnings.length > 0 && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900"><div className="flex gap-2"><Info size={13} className="mt-0.5 shrink-0" /><div>{sourceWarnings.slice(0, 2).map((warning, i) => <div key={i}>{warning.message ?? "Source warning"}</div>)}</div></div></div>}
    <div className="mt-3 flex items-center justify-between gap-2 flex-wrap"><div className="flex gap-3 flex-wrap">{item.source?.sourceKind === "pdf_upload" && <><a className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-primary hover:underline" href={`/api/planning-revisions/${r.id}/pdf?download=1`} download data-testid={`planning-envelope-pdf-${r.id}`}><Download size={12} /> Source PDF</a><a className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-primary hover:underline" href={`/api/planning-revisions/${r.id}/pdf`} target="_blank" rel="noopener noreferrer" data-testid={`planning-envelope-view-pdf-${r.id}`}><ExternalLink size={12} /> View PDF</a></>}{r.promotedDevisId && <a href={`/projets/${projectId}?tab=devis&devis=${r.promotedDevisId}`} className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 hover:underline" data-testid={`planning-envelope-live-link-${r.id}`}>Live devis #{r.promotedDevisId}</a>}</div><div className="flex gap-2 flex-wrap">{!immutable && !isArchived && <Button variant="outline" size="sm" onClick={onEdit} data-testid={`planning-envelope-edit-${r.id}`}><Pencil size={12} /> Edit</Button>}{r.status === "draft" && !isArchived && <Button variant="outline" size="sm" onClick={onReview} data-testid={`planning-envelope-review-${r.id}`}><Check size={12} /> Review</Button>}{canApprove && !isArchived && <Button variant="outline" size="sm" onClick={() => onAction(`/api/planning-revisions/${r.id}/approve`, { expectedVersion: r.version })} data-testid={`planning-envelope-approve-${r.id}`}><ShieldCheck size={12} /> Approve</Button>}{canRevise && !isArchived && <Button variant="outline" size="sm" onClick={() => onAction(`/api/planning-revisions/${r.id}/revise`, {})} data-testid={`planning-envelope-revise-${r.id}`}><RefreshCw size={12} /> Revise</Button>}{r.status === "approved" && !r.promotedDevisId && !isArchived && <Button size="sm" onClick={onPromote} data-testid={`planning-envelope-promote-${r.id}`}><FileCheck2 size={12} /> Promote to Live</Button>}</div></div>
  </LuxuryCard>;
}

interface RevisionDialogProps {
  open: boolean;
  item: Revision | null;
  contractors: Choice[];
  technicalLotsData: TechnicalLotsResponse | undefined;
  technicalLotsError: Error | null;
  technicalLotsFetching: boolean;
  technicalLotsIsStale: boolean;
  onTechnicalLotsRetry: () => void;
  pending: boolean;
  onClose: () => void;
  onSubmit: (body: unknown) => void;
}

function RevisionDialog({ open, item, contractors, technicalLotsData, technicalLotsError, technicalLotsFetching, technicalLotsIsStale, onTechnicalLotsRetry, pending, onClose, onSubmit }: RevisionDialogProps) {
  const r = item?.revision;
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState("");
  const [ht, setHt] = useState("");
  const [ttc, setTtc] = useState("");
  const [tva, setTva] = useState("20");
  const [contractorId, setContractorId] = useState("");
  const [archidocTechnicalLotId, setArchidocTechnicalLotId] = useState<string>("");
  const [auto, setAuto] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);

  // Determine currently saved technical lot (may be inactive/tombstoned)
  const savedTechnicalLot = item?.technicalLot ?? null;

  // Active lots available for new selection
  const activeLots = (technicalLotsData?.lots ?? []).filter(
    (lot) => lot.isActive && lot.deletedAt == null,
  );

  // If the saved lot is inactive/tombstoned, it must still appear as an option
  // on this revision so it remains readable. But it should not be selectable
  // for new revisions.
  const savedLotIsInactive =
    savedTechnicalLot != null &&
    (!savedTechnicalLot.isActive || savedTechnicalLot.deletedAt != null);
  const savedLotNeedsFallbackOption =
    savedTechnicalLot != null &&
    !activeLots.some((lot) => lot.id === savedTechnicalLot.id);

  // Whether the catalogue is unavailable (cold failure — no cached data at all)
  const catalogueColdFailure =
    (!!technicalLotsError && !technicalLotsData) ||
    (!!technicalLotsData && technicalLotsData.catalogue == null);

  // Whether we have stale data with a retriable error
  const catalogueStale =
    (!!technicalLotsError && !!technicalLotsData?.catalogue) ||
    (!!technicalLotsData?.catalogue && technicalLotsData.sync?.status === "failed");

  useEffect(() => {
    if (!open) return;
    setReference(r?.reference ?? "");
    setDescription(r?.descriptionFr ?? "");
    setDate(r?.documentDate ?? "");
    setHt(r?.amountHt ?? "");
    setTtc(r?.amountTtc ?? "");
    setTva(r?.tvaRatePercent ?? "20");
    setContractorId(r?.contractorId == null ? "" : String(r.contractorId));
    setArchidocTechnicalLotId(r?.archidocTechnicalLotId ?? "");
    setAuto(!!r?.tvaAutoliquidation);
    setLines(item?.lines?.length
      ? item.lines.map((line) => ({
          ...line,
          description: line.description ?? "",
          quantity: line.quantity ?? "",
          unit: line.unit ?? "",
          unitPriceHt: line.unitPriceHt ?? "",
          totalHt: line.totalHt ?? "",
        }))
      : [{ lineNumber: 1, description: "", quantity: "", unit: "", unitPriceHt: "", totalHt: "" }]);
  }, [open, item, r]);

  const updateLine = (index: number, field: keyof Line, value: string) => {
    setLines((old) => old.map((line, i) => {
      if (i !== index) return line;
      const next = { ...line, [field]: value };
      if (field === "quantity" || field === "unitPriceHt") {
        const nextQuantity = field === "quantity" ? value : line.quantity;
        const nextUnitPrice = field === "unitPriceHt" ? value : line.unitPriceHt;
        if (nextQuantity !== "" && nextUnitPrice !== "") {
          next.totalHt = (Number(nextQuantity) * Number(nextUnitPrice)).toFixed(2);
        }
      }
      return next;
    }));
  };

  const submit = () => {
    const populatedLines = lines
      .filter((line) => line.description.trim() !== "" || line.totalHt !== "")
      .map((line, index) => ({
        lineNumber: index + 1,
        description: line.description,
        quantity: line.quantity || null,
        unit: line.unit || null,
        unitPriceHt: line.unitPriceHt || null,
        totalHt: line.totalHt,
        pdfPageHint: line.pdfPageHint ?? null,
      }));
    onSubmit({
      contractorId: contractorId ? Number(contractorId) : null,
      archidocTechnicalLotId: archidocTechnicalLotId || null,
      reference,
      descriptionFr: description,
      documentDate: date || null,
      amountHt: ht,
      amountTtc: ttc,
      tvaRatePercent: tva || null,
      tvaAutoliquidation: auto,
      lines: populatedLines,
    });
  };
  const contractorChoices = contractors.filter(
    (contractor) => contractor.archidocOrphanedAt == null || String(contractor.id) === contractorId,
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[92dvh] overflow-y-auto" data-testid="planning-envelope-form">
        <DialogHeader>
          <DialogTitle>{item ? "Edit planning revision" : "New planning revision"}</DialogTitle>
          <DialogDescription>Amounts are stored as a planning candidate until review and approval.</DialogDescription>
        </DialogHeader>

        {/* Technical lots catalogue stale/error banner */}
        {catalogueStale && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="planning-lots-stale-banner">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="flex-1">Lot catalogue may be outdated. Displayed choices are from a prior load.</span>
            <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={onTechnicalLotsRetry} disabled={technicalLotsFetching} data-testid="planning-lots-retry">
              {technicalLotsFetching ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />} Retry
            </Button>
          </div>
        )}

        {catalogueColdFailure && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900" data-testid="planning-lots-unavailable-banner">
            <AlertTriangle size={13} className="shrink-0" />
            <span>Lot catalogue unavailable. Lot selection is disabled until the catalogue can be loaded.</span>
          </div>
        )}

        {item?.legacyLotNeedsReview && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="planning-legacy-lot-review-banner">
            <AlertTriangle size={13} className="shrink-0" />
            <span>The saved project lot did not match an ArchiDoc technical lot exactly. Review and choose the correct technical lot.</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label htmlFor="pe-reference">Reference</Label><Input id="pe-reference" value={reference} onChange={(e) => setReference(e.target.value)} data-testid="planning-envelope-form-reference" /></div>
          <div><Label htmlFor="pe-date">Document date</Label><Input id="pe-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="planning-envelope-form-date" /></div>
          <div>
            <Label>Contractor</Label>
            <Select value={contractorId || "__none__"} onValueChange={(value) => setContractorId(value === "__none__" ? "" : value)}>
              <SelectTrigger data-testid="planning-envelope-form-contractor"><SelectValue placeholder="Select contractor" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Not assigned</SelectItem>
                {contractorChoices.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name ?? c.companyName ?? `Contractor ${c.id}`}
                    {c.archidocPartnerType === "supplier" ? " — Supplier" : ""}
                    {c.archidocOrphanedAt != null ? " — No longer active" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Lot</Label>
            <Select
              value={archidocTechnicalLotId || "__none__"}
              onValueChange={(value) => setArchidocTechnicalLotId(value === "__none__" ? "" : value)}
              disabled={catalogueColdFailure}
            >
              <SelectTrigger data-testid="planning-envelope-form-lot">
                <SelectValue placeholder={catalogueColdFailure ? "Catalogue unavailable" : "Select lot"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Not assigned</SelectItem>
                {/* Render active lots in response order */}
                {activeLots.map((lot) => (
                  <SelectItem key={lot.id} value={lot.id} data-testid={`planning-lot-option-${lot.id}`}>
                    {lot.code} — {lot.labelFr}
                  </SelectItem>
                ))}
                {/* If the currently saved lot is inactive/tombstoned, show it as a read-only historic entry */}
                {savedLotNeedsFallbackOption && (
                  <SelectItem
                    key={savedTechnicalLot!.id}
                    value={savedTechnicalLot!.id}
                    data-testid={`planning-lot-option-inactive-${savedTechnicalLot!.id}`}
                  >
                    {savedTechnicalLot!.code} — {savedTechnicalLot!.labelFr}
                    {savedLotIsInactive ? " — No longer active" : " — Saved selection"}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2"><Label htmlFor="pe-description">Scope</Label><Textarea id="pe-description" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="planning-envelope-form-scope" /></div>
          <div><Label htmlFor="pe-ht">Amount HT</Label><Input id="pe-ht" type="number" min="0" step="0.01" value={ht} onChange={(e) => setHt(e.target.value)} data-testid="planning-envelope-form-ht" /></div>
          <div><Label htmlFor="pe-ttc">Amount TTC</Label><Input id="pe-ttc" type="number" min="0" step="0.01" value={ttc} onChange={(e) => setTtc(e.target.value)} data-testid="planning-envelope-form-ttc" /></div>
          <div><Label htmlFor="pe-tva">TVA rate %</Label><Input id="pe-tva" type="number" min="0" step="0.01" value={tva} onChange={(e) => setTva(e.target.value)} data-testid="planning-envelope-form-tva" /></div>
          <label className="flex items-center gap-2 text-xs pt-6"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-testid="planning-envelope-form-autoliquidation" /> TVA autoliquidation</label>
        </div>
        <div className="border-t pt-3">
          <div className="flex justify-between items-center mb-2">
            <TechnicalLabel>Line items</TechnicalLabel>
            <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, { lineNumber: lines.length + 1, description: "", quantity: "1", unit: "u", unitPriceHt: "", totalHt: "" }])} data-testid="planning-envelope-form-add-line"><Plus size={12} /> Add line</Button>
          </div>
          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end rounded-md border border-border/60 p-2 sm:border-0 sm:p-0">
                <div className="sm:col-span-4"><Label className="text-[10px] sm:sr-only">Description</Label><Input aria-label={`Line ${index + 1} description`} placeholder="Description" value={line.description} onChange={(e) => updateLine(index, "description", e.target.value)} data-testid={`planning-envelope-line-description-${index}`} /></div>
                <div className="sm:col-span-2"><Label className="text-[10px] sm:sr-only">Quantity</Label><Input aria-label="Quantity" type="number" min="0" step="0.001" placeholder="Qty" value={line.quantity} onChange={(e) => updateLine(index, "quantity", e.target.value)} /></div>
                <div className="sm:col-span-1"><Label className="text-[10px] sm:sr-only">Unit</Label><Input aria-label="Unit" placeholder="Unit" value={line.unit} onChange={(e) => updateLine(index, "unit", e.target.value)} /></div>
                <div className="sm:col-span-2"><Label className="text-[10px] sm:sr-only">Unit price HT</Label><Input aria-label="Unit price HT" type="number" min="0" step="0.01" placeholder="Unit price" value={line.unitPriceHt} onChange={(e) => updateLine(index, "unitPriceHt", e.target.value)} /></div>
                <div className="sm:col-span-2"><Label className="text-[10px] sm:sr-only">Total HT</Label><Input aria-label="Total HT" type="number" min="0" step="0.01" placeholder="Total HT" value={line.totalHt} onChange={(e) => updateLine(index, "totalHt", e.target.value)} data-testid={`planning-envelope-line-total-${index}`} /></div>
                <div className="sm:col-span-1 flex justify-end"><Button type="button" variant="ghost" size="icon" aria-label="Remove line" onClick={() => setLines(lines.filter((_, i) => i !== index))} disabled={lines.length === 1}><X size={13} /></Button></div>
              </div>
            ))}
          </div>
        </div>
        <Button disabled={pending || !reference.trim() || !description.trim() || !ht || !ttc} onClick={submit} data-testid="planning-envelope-form-submit">
          {pending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save revision
        </Button>
      </DialogContent>
    </Dialog>
  );
}
