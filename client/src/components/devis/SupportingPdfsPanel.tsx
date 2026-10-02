import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, FileText, LockKeyhole, Paperclip, Pencil, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { PdfPopoutViewer } from "./PdfPopoutViewer";
import { moveSupportingPdf, useSupportingPdfs, validateSupportingPdf, type SupportingPdf } from "./use-supporting-pdfs";
import "./supporting-pdfs.css";

interface Props {
  devisId: number;
  isArchived?: boolean;
  signOffStage?: string;
  status?: string;
  hasSigningSnapshot?: boolean;
}

export function supportingPdfsLockReason({ isArchived, signOffStage, status, hasSigningSnapshot }: Omit<Props, "devisId">): string | null {
  if (isArchived) return "This project is archived. Supporting documents are read-only.";
  if (status === "void" || signOffStage === "void") return "This quotation is void. Supporting documents are read-only.";
  if (status === "signed" || signOffStage === "client_signed_off") return "This quotation is signed. Its supporting documents cannot be changed.";
  if (hasSigningSnapshot || signOffStage === "sent_to_client") return "The quotation package is locked for signing. Its supporting documents cannot be changed.";
  return null;
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SupportingPdfsPanel(props: Props) {
  const { devisId } = props;
  const { documents, isLoading, isError, error, refetch, mutation } = useSupportingPdfs(devisId);
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rename, setRename] = useState<SupportingPdf | null>(null);
  const [label, setLabel] = useState("");
  const [remove, setRemove] = useState<SupportingPdf | null>(null);
  const [preview, setPreview] = useState<SupportingPdf | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const lockReason = supportingPdfsLockReason(props);
  const disabled = !!lockReason || mutation.isPending || isLoading || isError;
  const run = async (action: Parameters<typeof mutation.mutateAsync>[0]): Promise<boolean> => {
    if (disabled) return false;
    setActionError(null);
    try {
      await mutation.mutateAsync(action);
      if (action.kind === "upload") toast({ title: "Supporting PDF added", description: "It will follow the quotation in the client package." });
      return true;
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "The document could not be updated. Please retry.");
      return false;
    }
  };
  const upload = (file?: File) => {
    if (!file || disabled) return;
    const message = validateSupportingPdf(file);
    if (message) { setActionError(message); return; }
    void run({ kind: "upload", file });
  };
  return (
    <section className="supporting-pdfs rounded-xl border border-border bg-background/60 p-4" aria-labelledby={`supporting-title-${devisId}`} data-testid={`supporting-pdfs-${devisId}`}>
      <div className="supporting-pdfs__header">
        <div className="flex items-center gap-2.5">
          <Paperclip size={16} className="text-[#c1a27b]" />
          <div>
            <h3 id={`supporting-title-${devisId}`} className="text-[11px] font-bold uppercase tracking-widest text-foreground">Supporting documents</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">Window plans, drawings and other PDF references.</p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => fileInput.current?.click()} className="gap-2 text-[11px]">
          <Upload size={13} /> Add PDF
        </Button>
      </div>
      <input ref={fileInput} type="file" accept=".pdf,application/pdf" className="sr-only" tabIndex={-1} aria-label="Upload supporting PDF"
        disabled={disabled} onChange={(event) => { upload(event.target.files?.[0]); event.target.value = ""; }} />
      {lockReason && <p className="mt-3 flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-[11px] text-muted-foreground"><LockKeyhole size={13} className="mt-0.5 shrink-0" />{lockReason}</p>}
      {isLoading ? <div className="mt-4 space-y-2" aria-label="Loading supporting documents"><Skeleton className="h-14 w-full rounded-lg" /><Skeleton className="h-14 w-3/4 rounded-lg" /></div>
        : isError ? <div role="alert" className="mt-3 rounded-lg border border-destructive/20 p-3 text-[11px]"><p>Supporting documents could not be loaded.</p><p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : "Please try again."}</p><Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void refetch()}>Retry</Button></div>
        : documents.length > 0 ? (
          <ol className="supporting-pdfs__list" aria-label="Supporting PDFs in client package order">
            {documents.map((document, index) => <li className="supporting-pdfs__row" key={document.id}>
              <span className="supporting-pdfs__order">{String(index + 1).padStart(2, "0")}</span>
              <FileText size={18} className="shrink-0 text-[#c1a27b]" />
              <div className="min-w-0 flex-1">
                <button type="button" className="block max-w-full truncate text-left text-[12px] font-semibold hover:underline" onClick={() => setPreview(document)} title={`View ${document.label}`}>{document.label}</button>
                <p className="mt-1 text-[10px] text-muted-foreground">{document.pageCount} {document.pageCount === 1 ? "page" : "pages"} · {formatSize(document.byteSize)}<span className="hidden sm:inline"> · {document.fileName}</span></p>
              </div>
              <div className="supporting-pdfs__actions">
                <Button type="button" size="icon" variant="ghost" title="Move earlier" aria-label={`Move ${document.label} earlier`} disabled={disabled || index === 0} onClick={() => void run({ kind: "reorder", ids: moveSupportingPdf(documents, document.id, -1) })}><ArrowUp size={13} /></Button>
                <Button type="button" size="icon" variant="ghost" title="Move later" aria-label={`Move ${document.label} later`} disabled={disabled || index === documents.length - 1} onClick={() => void run({ kind: "reorder", ids: moveSupportingPdf(documents, document.id, 1) })}><ArrowDown size={13} /></Button>
                <Button type="button" size="icon" variant="ghost" title="Rename" aria-label={`Rename ${document.label}`} disabled={disabled} onClick={() => { setActionError(null); setRename(document); setLabel(document.label); }}><Pencil size={13} /></Button>
                <Button type="button" size="icon" variant="ghost" title="Remove" aria-label={`Remove ${document.label}`} disabled={disabled} onClick={() => { setActionError(null); setRemove(document); }}><Trash2 size={13} /></Button>
              </div>
            </li>)}
          </ol>
        ) : <div className="supporting-pdfs__drop" data-dragging={dragging} data-disabled={disabled}
          onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
          onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length > 1) { setActionError("Add one PDF at a time so you can check its place in the package."); return; } upload(event.dataTransfer.files[0]); }}>
          <FileText size={25} className="mt-0.5 shrink-0 text-[#c1a27b]" />
          <div><p className="text-[12px] font-semibold">Keep the plans with the quotation.</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{lockReason ? "No supporting PDFs were added to this quotation." : "Drop a PDF here, or choose Add PDF. Up to 20 MB per document."}</p></div>
        </div>}
      {mutation.isPending && <div role="status" className="mt-3"><Skeleton className="mb-2 h-1 w-full" /><p className="text-[11px] text-muted-foreground">Updating supporting documents…</p></div>}
      {actionError && !rename && !remove && <p role="alert" className="mt-3 text-[11px] text-destructive">{actionError}</p>}
      <p className="mt-3 flex items-start gap-2 text-[10px] leading-relaxed text-muted-foreground"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-[#c1a27b]" />PDFs are appended after the quotation in the order shown. The original French PDF is never changed.</p>
      <Dialog open={!!rename} onOpenChange={(open) => { if (!open && !mutation.isPending) setRename(null); }}>
        <DialogContent className="max-w-md"><DialogHeader><DialogTitle>Rename supporting document</DialogTitle><DialogDescription>Use a clear label for this quotation’s supporting PDF. The uploaded file stays unchanged.</DialogDescription></DialogHeader>
          <form onSubmit={async (event) => { event.preventDefault(); if (rename && label.trim() && await run({ kind: "rename", id: rename.id, label: label.trim() })) setRename(null); }} className="space-y-4">
            <div><label htmlFor={`supporting-label-${devisId}`} className="mb-2 block text-[11px] font-semibold">Document label</label><Input id={`supporting-label-${devisId}`} autoFocus maxLength={180} value={label} onChange={(event) => setLabel(event.target.value)} disabled={mutation.isPending} required /></div>
            {actionError && <p role="alert" className="text-[11px] text-destructive">{actionError}</p>}
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setRename(null)} disabled={mutation.isPending}>Cancel</Button><Button type="submit" disabled={disabled || !label.trim()}>{mutation.isPending ? "Saving…" : "Save label"}</Button></div>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!remove} onOpenChange={(open) => { if (!open && !mutation.isPending) setRemove(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove this supporting PDF?</AlertDialogTitle><AlertDialogDescription>“{remove?.label}” will be removed from future client quotation packages. The original quotation will not be changed.</AlertDialogDescription></AlertDialogHeader>
          {actionError && <p role="alert" className="text-[11px] text-destructive">{actionError}</p>}
          <AlertDialogFooter><AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel><Button type="button" variant="destructive" disabled={disabled} onClick={async () => { if (remove && await run({ kind: "remove", id: remove.id })) setRemove(null); }}>{mutation.isPending ? "Removing…" : "Remove PDF"}</Button></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {preview && <PdfPopoutViewer devisCode={preview.label} pdfUrl={`/api/devis/${devisId}/supporting-pdfs/${preview.id}/pdf`} downloadUrl={`/api/devis/${devisId}/supporting-pdfs/${preview.id}/pdf?download=1`} downloadName={preview.fileName} viewerId={`supporting-${devisId}-${preview.id}`} onClose={() => setPreview(null)} />}
    </section>
  );
}