import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, FileWarning } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Contractor, Devis } from "@shared/schema";

type PromotionKind = "devis" | "invoice";

export interface ManualPromotionSource {
  id: number;
  projectId: number;
  fileName: string;
  fingerprint?: string | null;
  reason?: string | null;
  endpoint: "intake" | "email";
}

export function ManualPromotionDialog({ source, onClose }: { source: ManualPromotionSource; onClose: () => void }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [kind, setKind] = useState<PromotionKind>("devis");
  const [contractorId, setContractorId] = useState("");
  const [devisId, setDevisId] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const { data: contractors = [] } = useQuery<Contractor[]>({ queryKey: ["/api/contractors"] });
  const { data: devis = [] } = useQuery<Devis[]>({
    queryKey: ["/api/projects", String(source.projectId), "devis"],
  });
  const eligibleDevis = devis.filter((item) => item.status !== "void" && item.accountingState !== "superseded");
  const selectedDevis = eligibleDevis.find((item) => String(item.id) === devisId);
  const canSubmit = confirmed && note.trim().length >= 10
    && (kind === "devis" ? contractorId !== "" : devisId !== "");

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        confirmed: true,
        kind,
        note: note.trim(),
      };
      if (source.fingerprint) body.expectedFingerprint = source.fingerprint;
      if (kind === "devis") body.contractorId = Number(contractorId);
      else body.devisId = Number(devisId);
      const response = await apiRequest(
        "POST",
        `/${source.endpoint === "intake" ? "api/intake-documents" : "api/email-documents"}/${source.id}/manual-promote`,
        body,
      );
      return response.json() as Promise<{ kind: PromotionKind; id: number; projectId: number; replayed: boolean }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contractors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(source.projectId), "intake"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(source.projectId), "devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(source.projectId), "invoices"] });
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey.some((part) => typeof part === "string" && (part.includes("devis") || part.includes("invoice"))) });
      toast({ title: result.replayed ? "Promotion already recorded" : "Draft created", description: "The incomplete draft is ready for normal review." });
      onClose();
      setLocation(result.kind === "devis"
        ? `/projets/${result.projectId}?devis=${result.id}`
        : `/projets/${result.projectId}?tab=factures&invoice=${result.id}`);
    },
    onError: (error: Error) => toast({ title: "Manual promotion failed", description: error.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <DialogContent data-testid="dialog-manual-promotion" className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><AlertTriangle size={17} className="text-amber-600" />Submit anyway</DialogTitle>
          <DialogDescription>
            This deliberate override creates an incomplete draft for normal review. It never approves or pays anything.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/20">
            <div className="flex items-start gap-2">
              <FileWarning size={15} className="mt-0.5 shrink-0 text-amber-700" />
              <div className="min-w-0">
                <p className="font-semibold break-words">{source.fileName}</p>
                <p className="mt-1 text-xs text-amber-900/75 dark:text-amber-100/75">{source.reason || "This document was parked before automatic routing."}</p>
              </div>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Promote as</Label>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Promotion kind">
              <Button type="button" variant={kind === "devis" ? "default" : "outline"} onClick={() => setKind("devis")} data-testid="button-manual-promotion-kind-devis">Devis</Button>
              <Button type="button" variant={kind === "invoice" ? "default" : "outline"} onClick={() => setKind("invoice")} data-testid="button-manual-promotion-kind-invoice">Facture</Button>
            </div>
          </div>
          {kind === "devis" ? (
            <div className="grid gap-2">
              <Label htmlFor="manual-promotion-contractor">Contractor <span className="text-destructive">*</span></Label>
              <Select value={contractorId} onValueChange={setContractorId}>
                <SelectTrigger id="manual-promotion-contractor" data-testid="select-manual-promotion-contractor"><SelectValue placeholder="Choose the contractor" /></SelectTrigger>
                <SelectContent>{contractors.map((contractor) => <SelectItem key={contractor.id} value={String(contractor.id)}>{contractor.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="manual-promotion-devis">Target devis <span className="text-destructive">*</span></Label>
              <Select value={devisId} onValueChange={setDevisId}>
                <SelectTrigger id="manual-promotion-devis" data-testid="select-manual-promotion-devis"><SelectValue placeholder="Choose the target devis" /></SelectTrigger>
                <SelectContent>{eligibleDevis.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.devisCode} — {item.descriptionFr}</SelectItem>)}</SelectContent>
              </Select>
              {selectedDevis && <p className="text-[11px] text-muted-foreground">Contractor derived from {selectedDevis.devisCode}.</p>}
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="manual-promotion-note">Reason for override <span className="text-destructive">*</span></Label>
            <Input id="manual-promotion-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Explain why this document should enter review" data-testid="input-manual-promotion-note" />
            <p className="text-[11px] text-muted-foreground">{note.trim().length}/10 characters minimum</p>
          </div>
          <label className="flex items-start gap-3 text-xs leading-5">
            <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} data-testid="checkbox-manual-promotion-confirmation" />
            <span>I understand this is a manual override tied to this exact PDF and creates only an incomplete draft.</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending} data-testid="button-manual-promotion-submit">
            {mutation.isPending ? "Submitting…" : "Submit anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}