/**
 * Project-detail "Design Contract" card.
 *
 * Reads /api/projects/:id/design-contract and renders:
 *   - Header with totals + reference + a download button for the PDF.
 *   - Milestone list with status pill (reached / pending), trigger label,
 *     percentage, € TTC, "Mark reached" button (manual override) and
 *     stage-specific "Record invoice" / "Mark paid" dialogs.
 *   - Replace-PDF dropzone driven by <DesignContractUpload mode="replace" />.
 *
 * If the project has no design contract yet (legacy or partial creation
 * fallout) the card renders an empty state inviting the architect to
 * upload one.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FileText, Download, CheckCircle2, Circle, Loader2, AlertCircle, Receipt, Wallet, Mail, Plus } from "lucide-react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DesignContractUpload, type ConfirmedDesignContract } from "./DesignContractUpload";
import type { ArchitectFeeInvoice, DesignContract, DesignContractMilestone, DesignContractTriggerEvent, MilestonePaymentSuggestion } from "@shared/schema";

type MilestoneSuggestionWithContext = MilestonePaymentSuggestion & {
  milestoneLabel: string;
  milestoneSequence: number;
  milestoneStatus: string;
};

type MilestoneWithExtras = DesignContractMilestone & {
  pennylaneInvoiceNumber?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  paymentDate?: string | null;
};

interface DesignContractResponse {
  contract: DesignContract;
  milestones: MilestoneWithExtras[];
}

const TRIGGER_LABELS: Record<DesignContractTriggerEvent, string> = {
  file_opened: "File opened",
  concept_signed: "Concept signed",
  permit_deposited: "Permit deposited",
  final_plans_signed: "Final plans signed",
  manual: "Manual tick",
};

function fmtEur(n: number | string | null | undefined): string {
  if (n == null) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(v);
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [year, month, day] = s.split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString();
  }
  return new Date(s).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Record Invoice dialog (reached → invoiced)
// ---------------------------------------------------------------------------
interface RecordInvoiceDialogProps {
  milestoneId: number;
  projectId: number;
  open: boolean;
  onClose: () => void;
}

function RecordInvoiceDialog({ milestoneId, projectId, open, onClose }: RecordInvoiceDialogProps) {
  const { toast } = useToast();
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/design-contracts/milestones/${milestoneId}/invoice`, {
        invoiceNumber,
        invoiceDate,
        ...(notes ? { notes } : {}),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "design-contract"] });
      toast({ title: "Invoice recorded", description: `Invoice ${invoiceNumber} saved for this milestone.` });
      onClose();
      setInvoiceNumber("");
      setInvoiceDate("");
      setNotes("");
    },
    onError: (err: Error) => {
      toast({ title: "Could not record invoice", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="dialog-record-invoice">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-black uppercase tracking-tight">
            Record Invoice
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="inv-number">
              <TechnicalLabel>Invoice Number</TechnicalLabel>
            </Label>
            <Input
              id="inv-number"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="e.g. FA-2024-042"
              data-testid="input-invoice-number"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="inv-date">
              <TechnicalLabel>Invoice Date</TechnicalLabel>
            </Label>
            <Input
              id="inv-date"
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              data-testid="input-invoice-date"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="inv-notes">
              <TechnicalLabel>Notes (optional)</TechnicalLabel>
            </Label>
            <Textarea
              id="inv-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
              data-testid="input-invoice-notes"
              className="mt-1 text-xs"
              rows={2}
            />
          </div>
          <Button
            className="w-full"
            disabled={mutation.isPending || !invoiceNumber || !invoiceDate}
            onClick={() => mutation.mutate()}
            data-testid="button-submit-record-invoice"
          >
            {mutation.isPending ? (
              <><Loader2 size={12} className="animate-spin mr-2" />Saving…</>
            ) : (
              <span className="text-[9px] font-bold uppercase tracking-widest">Save Invoice</span>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Mark Paid dialog (invoiced → paid)
// ---------------------------------------------------------------------------
interface MarkPaidDialogProps {
  milestoneId: number;
  projectId: number;
  open: boolean;
  onClose: () => void;
  invoiceNumber: string | null;
  invoiceDate: string | null;
}

function MarkPaidDialog({
  milestoneId,
  projectId,
  open,
  onClose,
  invoiceNumber,
  invoiceDate,
}: MarkPaidDialogProps) {
  const { toast } = useToast();
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/design-contracts/milestones/${milestoneId}/payment`, {
        paymentDate,
        ...(notes ? { notes } : {}),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "design-contract"] });
      toast({ title: "Milestone marked paid", description: `Payment recorded on ${paymentDate}.` });
      onClose();
      setPaymentDate(new Date().toISOString().slice(0, 10));
      setNotes("");
    },
    onError: (err: Error) => {
      toast({ title: "Could not mark paid", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="dialog-mark-paid">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-black uppercase tracking-tight">
            Mark Milestone Paid
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded border border-border bg-muted/30 px-3 py-2 text-xs">
            <TechnicalLabel>Invoice</TechnicalLabel>
            <p className="mt-1" data-testid="text-payment-dialog-invoice-number">
              {invoiceNumber ?? "Invoice number unavailable"}
            </p>
            <p className="text-muted-foreground" data-testid="text-payment-dialog-invoice-date">
              {invoiceDate ? fmtDate(invoiceDate) : "Invoice date unavailable"}
            </p>
          </div>
          <div>
            <Label htmlFor="pay-date">
              <TechnicalLabel>Payment Date</TechnicalLabel>
            </Label>
            <Input
              id="pay-date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              data-testid="input-payment-date"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="pay-notes">
              <TechnicalLabel>Notes (optional)</TechnicalLabel>
            </Label>
            <Textarea
              id="pay-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
              data-testid="input-payment-notes"
              className="mt-1 text-xs"
              rows={2}
            />
          </div>
          <Button
            className="w-full"
            disabled={mutation.isPending || !paymentDate}
            onClick={() => mutation.mutate()}
            data-testid="button-submit-mark-paid"
          >
            {mutation.isPending ? (
              <><Loader2 size={12} className="animate-spin mr-2" />Saving…</>
            ) : (
              <span className="text-[9px] font-bold uppercase tracking-widest">Confirm Paid</span>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add Details dialog (paid legacy milestone missing invoice/payment details)
// ---------------------------------------------------------------------------
interface AddDetailsDialogProps {
  milestoneId: number;
  projectId: number;
  open: boolean;
  onClose: () => void;
  existing: { invoiceNumber?: string | null; invoiceDate?: string | null; paymentDate?: string | null; notes?: string | null };
}

function AddDetailsDialog({ milestoneId, projectId, open, onClose, existing }: AddDetailsDialogProps) {
  const { toast } = useToast();
  const [invoiceNumber, setInvoiceNumber] = useState(existing.invoiceNumber ?? "");
  const [invoiceDate, setInvoiceDate] = useState(existing.invoiceDate ?? "");
  const [paymentDate, setPaymentDate] = useState(existing.paymentDate ?? "");
  const [notes, setNotes] = useState(existing.notes ?? "");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/design-contracts/milestones/${milestoneId}/details`, {
        invoiceNumber,
        invoiceDate,
        paymentDate,
        ...(notes ? { notes } : {}),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "design-contract"] });
      toast({ title: "Details saved", description: "Invoice and payment details updated." });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Could not save details", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="dialog-add-details">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-black uppercase tracking-tight">
            Add Invoice &amp; Payment Details
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="det-inv-number">
              <TechnicalLabel>Invoice Number</TechnicalLabel>
            </Label>
            <Input
              id="det-inv-number"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="e.g. FA-2024-042"
              data-testid="input-details-invoice-number"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="det-inv-date">
              <TechnicalLabel>Invoice Date</TechnicalLabel>
            </Label>
            <Input
              id="det-inv-date"
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              data-testid="input-details-invoice-date"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="det-pay-date">
              <TechnicalLabel>Payment Date</TechnicalLabel>
            </Label>
            <Input
              id="det-pay-date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              data-testid="input-details-payment-date"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="det-notes">
              <TechnicalLabel>Notes (optional)</TechnicalLabel>
            </Label>
            <Textarea
              id="det-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
              data-testid="input-details-notes"
              className="mt-1 text-xs"
              rows={2}
            />
          </div>
          <Button
            className="w-full"
            disabled={mutation.isPending || !invoiceNumber || !invoiceDate || !paymentDate}
            onClick={() => mutation.mutate()}
            data-testid="button-submit-add-details"
          >
            {mutation.isPending ? (
              <><Loader2 size={12} className="animate-spin mr-2" />Saving…</>
            ) : (
              <span className="text-[9px] font-bold uppercase tracking-widest">Save Details</span>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------
interface DesignContractCardProps {
  projectId: number;
}

export function DesignContractCard({ projectId }: DesignContractCardProps) {
  const { toast } = useToast();
  const [pendingReplace, setPendingReplace] = useState<ConfirmedDesignContract | null>(null);

  // Per-milestone dialog state
  const [invoiceDialogId, setInvoiceDialogId] = useState<number | null>(null);
  const [paidDialogId, setPaidDialogId] = useState<number | null>(null);
  const [detailsDialogId, setDetailsDialogId] = useState<number | null>(null);

  const { data, isLoading, error } = useQuery<DesignContractResponse | null>({
    queryKey: ["/api/projects", String(projectId), "design-contract"],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/design-contract`, { credentials: "include" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      return res.json();
    },
  });

  const replaceMutation = useMutation({
    mutationFn: async (payload: ConfirmedDesignContract) => {
      // Re-upload destroys the prior milestone schedule — confirm before
      // we overwrite. Skipped when no contract exists yet (empty-state).
      if (data) {
        const ok = window.confirm(
          "Replacing the design contract will archive the existing PDF and overwrite the current milestone schedule. Continue?",
        );
        if (!ok) {
          const e = new Error("Cancelled");
          (e as Error & { __cancelled?: boolean }).__cancelled = true;
          throw e;
        }
      }
      const res = await apiRequest("POST", `/api/projects/${projectId}/design-contract`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "design-contract"] });
      setPendingReplace(null);
      toast({ title: "Design contract saved", description: "The new contract has been stored and the previous version archived." });
    },
    onError: (err: Error) => {
      if ((err as Error & { __cancelled?: boolean }).__cancelled) {
        setPendingReplace(null);
        return;
      }
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const markReachedMutation = useMutation({
    mutationFn: async (milestoneId: number) => {
      const res = await apiRequest("PATCH", `/api/design-contracts/milestones/${milestoneId}`, {
        status: "reached",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "design-contract"] });
      toast({ title: "Milestone marked reached" });
    },
    onError: (err: Error) => {
      toast({ title: "Could not update milestone", description: err.message, variant: "destructive" });
    },
  });

  // Task #617 — open "client paid" email suggestions for this project's milestones.
  const { data: paymentSuggestions } = useQuery<MilestoneSuggestionWithContext[]>({
    queryKey: ["/api/projects", String(projectId), "milestone-payment-suggestions"],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/milestone-payment-suggestions`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      return res.json();
    },
  });

  const suggestionMutation = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "confirm" | "dismiss" }) => {
      const res = await apiRequest("POST", `/api/milestone-payment-suggestions/${id}/${action}`);
      return res.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "milestone-payment-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "design-contract"] });
      toast({ title: vars.action === "confirm" ? "Payment confirmed — milestone marked paid" : "Suggestion dismissed" });
    },
    onError: (err: Error) => {
      toast({ title: "Could not process suggestion", description: err.message, variant: "destructive" });
    },
  });

  // Task #617 — Gmail-detected pending fee invoices that plausibly belong to
  // this project (ranked candidate or exact milestone-amount match).
  const { data: pendingInvoices } = useQuery<ArchitectFeeInvoice[]>({
    queryKey: ["/api/architect-fee-invoices", { status: "pending_review" }],
    queryFn: async () => {
      const res = await fetch(`/api/architect-fee-invoices?status=pending_review`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <LuxuryCard data-testid="card-design-contract-loading">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Loading design contract…
        </div>
      </LuxuryCard>
    );
  }

  if (error) {
    return (
      <LuxuryCard data-testid="card-design-contract-error">
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle size={14} /> Failed to load design contract: {error.message}
        </div>
      </LuxuryCard>
    );
  }

  if (!data) {
    return (
      <LuxuryCard data-testid="card-design-contract-empty">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileText size={16} />
            <h3 className="text-[14px] font-black uppercase tracking-tight">Design Contract</h3>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          No design contract on file. Upload the signed PDF — the AI will extract the totals and payment milestones.
        </p>
        <DesignContractUpload
          confirmed={pendingReplace}
          onConfirmed={(p) => { setPendingReplace(p); replaceMutation.mutate(p); }}
          onCleared={() => setPendingReplace(null)}
          mode="replace"
        />
      </LuxuryCard>
    );
  }

  const { contract, milestones } = data;
  const reachedCount = milestones.filter((m) => m.status !== "pending").length;

  // A pending detected invoice "plausibly matches" this project when the
  // ranker listed the project as a candidate, or its TTC equals an
  // uninvoiced milestone amount.
  const uninvoicedAmounts = new Set(
    milestones
      .filter((m) => m.status === "pending" || m.status === "reached")
      .map((m) => Number(m.amountTtc).toFixed(2)),
  );
  const matchingPendingInvoices = (pendingInvoices ?? []).filter((inv) => {
    const cand = inv.candidates as { projects?: { projectId: number }[] } | null;
    if (cand?.projects?.some((p) => p.projectId === projectId)) return true;
    if (inv.amountTtc != null && uninvoicedAmounts.has(Number(inv.amountTtc).toFixed(2))) return true;
    return false;
  });
  const suggestionByMilestone = new Map<number, MilestoneSuggestionWithContext>();
  for (const s of paymentSuggestions ?? []) {
    if (!suggestionByMilestone.has(s.milestoneId)) suggestionByMilestone.set(s.milestoneId, s);
  }
  const STATUS_STYLE: Record<string, { bg: string; badge: string; label: string }> = {
    pending: { bg: "bg-card border-border", badge: "bg-muted text-muted-foreground", label: "Pending" },
    reached: { bg: "bg-amber-50 border-amber-200", badge: "bg-amber-100 text-amber-900", label: "Reached" },
    invoiced: { bg: "bg-sky-50 border-sky-200", badge: "bg-sky-100 text-sky-900", label: "Invoiced" },
    paid: { bg: "bg-emerald-50 border-emerald-200", badge: "bg-emerald-100 text-emerald-900", label: "Paid" },
  };

  // Find the milestone for the currently-open dialogs
  const invoiceDialogMilestone = invoiceDialogId != null ? milestones.find((m) => m.id === invoiceDialogId) : null;
  const paidDialogMilestone = paidDialogId != null ? milestones.find((m) => m.id === paidDialogId) : null;
  const detailsDialogMilestone = detailsDialogId != null ? milestones.find((m) => m.id === detailsDialogId) : null;

  return (
    <LuxuryCard data-testid="card-design-contract">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <FileText size={16} />
          <h3 className="text-[14px] font-black uppercase tracking-tight">Design Contract</h3>
          {contract.contractReference && (
            <Badge variant="outline" className="text-[10px]" data-testid="badge-contract-reference">
              {contract.contractReference}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/projects/${projectId}/design-contract/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-bold text-[#0B2545] hover:underline"
            data-testid="link-download-design-contract-pdf"
          >
            <Download size={12} /> PDF
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div>
          <TechnicalLabel>Total TTC</TechnicalLabel>
          <p className="text-[16px] font-light" data-testid="text-design-contract-total-ttc">{fmtEur(contract.totalTtc)}</p>
        </div>
        <div>
          <TechnicalLabel>Total HT</TechnicalLabel>
          <p className="text-[16px] font-light" data-testid="text-design-contract-total-ht">{fmtEur(contract.totalHt)}</p>
        </div>
        <div>
          <TechnicalLabel>Conception HT</TechnicalLabel>
          <p className="text-[16px] font-light">{fmtEur(contract.conceptionAmountHt)}</p>
        </div>
        <div>
          <TechnicalLabel>Planning HT</TechnicalLabel>
          <p className="text-[16px] font-light">{fmtEur(contract.planningAmountHt)}</p>
        </div>
      </div>

      {(contract.clientName || contract.architectName || contract.projectAddress) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 p-3 rounded border border-border bg-muted/30">
          <div>
            <TechnicalLabel>Client</TechnicalLabel>
            <p className="text-[12px]" data-testid="text-design-contract-client-name">{contract.clientName ?? "—"}</p>
          </div>
          <div>
            <TechnicalLabel>Architect</TechnicalLabel>
            <p className="text-[12px]" data-testid="text-design-contract-architect-name">{contract.architectName ?? "—"}</p>
          </div>
          <div>
            <TechnicalLabel>Project address</TechnicalLabel>
            <p className="text-[12px]" data-testid="text-design-contract-project-address">{contract.projectAddress ?? "—"}</p>
          </div>
        </div>
      )}

      {matchingPendingInvoices.length > 0 && (
        <Link href="/honoraires/factures-detectees">
          <div
            className="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 mb-4 cursor-pointer hover-elevate"
            data-testid="alert-contract-pending-invoice"
          >
            <Receipt size={14} className="text-amber-600 shrink-0" />
            <p className="text-xs text-amber-900 dark:text-amber-200">
              {matchingPendingInvoices.length === 1
                ? `Facture détectée ${matchingPendingInvoices[0].invoiceNumber ?? ""} (${fmtEur(matchingPendingInvoices[0].amountTtc)}) semble correspondre à ce contrat — à vérifier.`
                : `${matchingPendingInvoices.length} factures détectées semblent correspondre à ce contrat — à vérifier.`}
            </p>
          </div>
        </Link>
      )}

      <div className="space-y-2 mb-4">
        <div className="flex items-center justify-between">
          <TechnicalLabel>Payment milestones ({reachedCount}/{milestones.length} reached)</TechnicalLabel>
        </div>
        <div className="space-y-1">
          {milestones.map((m) => {
            const style = STATUS_STYLE[m.status] ?? STATUS_STYLE.pending;
            const Icon =
              m.status === "paid" ? Wallet :
              m.status === "invoiced" ? Receipt :
              m.status === "reached" ? CheckCircle2 :
              Circle;

            // Is this a "legacy paid" milestone missing invoice/payment details?
            const isPaidLegacy =
              m.status === "paid" &&
              (!m.invoiceNumber || !m.invoiceDate || !m.paymentDate);

            return (
            <div key={m.id} className="space-y-1">
            <div
              className={`flex items-center gap-3 p-2 rounded border ${style.bg}`}
              data-testid={`row-milestone-detail-${m.id}`}
            >
              <Icon size={14} className="text-foreground/70" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate flex items-center gap-2">
                  #{m.sequence} · {m.labelFr}
                  <span
                    className={`text-[9px] uppercase px-1.5 py-0.5 rounded ${style.badge}`}
                    data-testid={`badge-milestone-status-${m.id}`}
                  >{style.label}</span>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Trigger: {TRIGGER_LABELS[m.triggerEvent as DesignContractTriggerEvent]}
                  {m.reachedAt ? ` · reached ${fmtDate(m.reachedAt as unknown as string)}` : ""}
                  {m.invoiceNumber ? (
                    <span data-testid={`text-milestone-invoice-number-${m.id}`}>
                      {" · Invoice "}{m.invoiceNumber}
                    </span>
                  ) : null}
                  {m.invoiceDate ? (
                    <span data-testid={`text-milestone-invoice-date-${m.id}`}>
                      {" dated "}{fmtDate(m.invoiceDate)}
                    </span>
                  ) : null}
                  {m.invoicedAt && !m.invoiceDate ? ` · invoiced ${fmtDate(m.invoicedAt as unknown as string)}` : ""}
                  {(m.status === "invoiced" || m.status === "paid") &&
                  m.pennylaneInvoiceNumber &&
                  m.pennylaneInvoiceNumber !== m.invoiceNumber ? (
                    <span data-testid={`text-milestone-pennylane-number-${m.id}`}>
                      {" · Pennylane "}{m.pennylaneInvoiceNumber}
                    </span>
                  ) : null}
                  {m.paymentDate ? (
                    <span data-testid={`text-milestone-payment-date-${m.id}`}>
                      {" · paid "}{fmtDate(m.paymentDate)}
                    </span>
                  ) : m.paidAt ? (
                    ` · paid ${fmtDate(m.paidAt as unknown as string)}`
                  ) : null}
                  {m.notes ? (
                    <span data-testid={`text-milestone-notes-${m.id}`}>
                      {" · "}{m.notes}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs font-medium" data-testid={`text-milestone-amount-${m.id}`}>{fmtEur(m.amountTtc)}</div>
                <div className="text-[10px] text-muted-foreground">{Number(m.percentage).toFixed(2)}%</div>
              </div>
              {m.status === "pending" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px]"
                  disabled={markReachedMutation.isPending}
                  onClick={() => markReachedMutation.mutate(m.id)}
                  data-testid={`button-mark-reached-${m.id}`}
                >
                  Mark reached
                </Button>
              )}
              {m.status === "reached" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px]"
                  onClick={() => setInvoiceDialogId(m.id)}
                  data-testid={`button-record-invoice-${m.id}`}
                >
                  Record invoice
                </Button>
              )}
              {m.status === "invoiced" && !suggestionByMilestone.has(m.id) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px]"
                  onClick={() => setPaidDialogId(m.id)}
                  data-testid={`button-mark-paid-${m.id}`}
                >
                  Mark paid
                </Button>
              )}
              {isPaidLegacy && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px] flex items-center gap-1"
                  onClick={() => setDetailsDialogId(m.id)}
                  data-testid={`button-add-details-${m.id}`}
                >
                  <Plus size={10} /> Add details
                </Button>
              )}
            </div>
            {(() => {
              const s = suggestionByMilestone.get(m.id);
              if (!s || m.status !== "invoiced") return null;
              return (
                <div
                  className="flex items-center gap-2 flex-wrap rounded border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 px-3 py-2 ml-6"
                  data-testid={`suggestion-milestone-paid-${m.id}`}
                >
                  <Mail size={12} className="text-emerald-600 shrink-0" />
                  <p className="text-[11px] text-emerald-900 dark:text-emerald-200 flex-1 min-w-0">
                    {s.status === "ambiguous"
                      ? `Réponse client de ${s.senderEmail} à vérifier (paiement possible).`
                      : `Le client (${s.senderEmail}) indique avoir payé ${fmtEur(s.suggestedAmount)} le ${s.suggestedDate}.`}
                    {s.matchedExcerpt ? ` « ${s.matchedExcerpt} »` : ""}
                  </p>
                  <Button
                    size="sm"
                    className="h-7 text-[10px]"
                    disabled={suggestionMutation.isPending}
                    onClick={() => suggestionMutation.mutate({ id: s.id, action: "confirm" })}
                    data-testid={`button-suggestion-confirm-${s.id}`}
                  >
                    Confirmer payé
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px]"
                    disabled={suggestionMutation.isPending}
                    onClick={() => suggestionMutation.mutate({ id: s.id, action: "dismiss" })}
                    data-testid={`button-suggestion-dismiss-${s.id}`}
                  >
                    Écarter
                  </Button>
                </div>
              );
            })()}
            </div>
            );
          })}
        </div>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground" data-testid="toggle-replace-design-contract">
          Replace contract (re-upload)
        </summary>
        <div className="mt-3">
          <DesignContractUpload
            confirmed={pendingReplace}
            onConfirmed={(p) => { setPendingReplace(p); replaceMutation.mutate(p); }}
            onCleared={() => setPendingReplace(null)}
            mode="replace"
          />
        </div>
      </details>

      {/* Stage-specific dialogs */}
      {invoiceDialogMilestone && (
        <RecordInvoiceDialog
          milestoneId={invoiceDialogMilestone.id}
          projectId={projectId}
          open={invoiceDialogId !== null}
          onClose={() => setInvoiceDialogId(null)}
        />
      )}
      {paidDialogMilestone && (
        <MarkPaidDialog
          milestoneId={paidDialogMilestone.id}
          projectId={projectId}
          open={paidDialogId !== null}
          onClose={() => setPaidDialogId(null)}
          invoiceNumber={paidDialogMilestone.invoiceNumber ?? null}
          invoiceDate={paidDialogMilestone.invoiceDate ?? null}
        />
      )}
      {detailsDialogMilestone && (
        <AddDetailsDialog
          milestoneId={detailsDialogMilestone.id}
          projectId={projectId}
          open={detailsDialogId !== null}
          onClose={() => setDetailsDialogId(null)}
          existing={{
            invoiceNumber: detailsDialogMilestone.invoiceNumber,
            invoiceDate: detailsDialogMilestone.invoiceDate,
            paymentDate: detailsDialogMilestone.paymentDate,
            notes: detailsDialogMilestone.notes,
          }}
        />
      )}
    </LuxuryCard>
  );
}
