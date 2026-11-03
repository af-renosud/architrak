import { BlockedAction, focusActionTarget, type ActionRequirement } from "@/components/ui/blocked-action";
import { certificateSendRequirements } from "./certificate-action-requirements";
/**
 * Task #573 — shared CertificatDetailDialog with full payment capability.
 *
 * Extracted from the /certificats page so the same payment-capable dialog
 * (Paiements Client section: ledger, suggestions, register/edit/delete) can
 * be opened from within a project's Certificats tab too.
 */

import { useCallback, useRef, useState } from "react";
import { PdfPopoutViewer } from "@/components/devis/PdfPopoutViewer";
import "./payment-evidence.css";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { allocationsMatch, evidenceFileError, paymentStateReason, useCertificatPaymentContext, type PaymentWithEvidence } from "@/hooks/use-certificat-payment-context";
import { ArchitectInvoiceSection } from "@/components/certificats/ArchitectInvoiceSection";
import { PennylaneInvoiceDescription } from "./PennylaneInvoiceDescription";
import { useInvoiceAwareCertificatSend } from "@/hooks/use-invoice-aware-certificat-send";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExternalLink, AlertTriangle, Plus, Copy, Send, Loader2 } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, invalidateCertificatPaymentData, projectScopedKey, queryClient } from "@/lib/queryClient";
import type { Certificat, CertificatWithTvaEvidenceReference, Contractor, CertificatPaymentSuggestion } from "@shared/schema";
import {
  hasCertificatDeliveryEvidence,
  isFalseSentCertificat,
  type CertificatWithDelivery,
} from "@/lib/certificat-delivery";

import { Amount } from "@/components/ui/amount";
import { formatCurrency as fmt } from "@/lib/utils";

interface PaymentLedgerResponse {
  payments: PaymentWithEvidence[];
  audits?: Array<{ id: number; paymentId: number; action: string; createdAt: string; snapshot: PaymentWithEvidence | null }>;
  paidToDate: number;
  outstanding: number;
  fullyPaid: boolean;
  overpaid: boolean;
}
interface CertificatSource {
  id: number;
  invoice?: {
    id: number;
    invoiceNumber: string;
    dateIssued: string | null;
    amountHt: string;
    tvaAmount: string | null;
    amountTtc: string;
  } | null;
}
type CertificatWithSupplierPresentation = CertificatWithDelivery &
  CertificatWithTvaEvidenceReference;

// Task #466 — a single draft suggestion (client "paid" reply).
function PaymentSuggestionCard({ suggestion, onDone }: { suggestion: CertificatPaymentSuggestion; onDone: () => void }) {
  const { toast } = useToast();
  const [datePaid, setDatePaid] = useState(suggestion.suggestedDate);
  const [amount, setAmount] = useState(suggestion.suggestedAmount);
  const [method, setMethod] = useState<"virement" | "cheque" | "autre">("virement");
  const ambiguous = suggestion.status === "ambiguous";

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/certificat-payment-suggestions/${suggestion.id}/confirm`, { datePaid, amount, method });
      return res.json() as Promise<{ fullyPaid: boolean; overpaid: boolean }>;
    },
    onSuccess: (r) => {
      onDone();
      toast({
        title: r.fullyPaid ? "Paiement confirmé — certificat soldé" : "Paiement confirmé",
        description: r.overpaid ? "Attention : le total encaissé dépasse le montant TTC." : "Enregistré au journal des paiements (source e-mail).",
        variant: r.overpaid ? "destructive" : undefined,
      });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/certificat-payment-suggestions/${suggestion.id}/dismiss`, {})).json(),
    onSuccess: () => {
      onDone();
      toast({ title: "Suggestion ignorée" });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  return (
    <div
      className="space-y-2 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20 p-3"
      data-testid={`card-payment-suggestion-${suggestion.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-400">
          {suggestion.kind === "contractor_received"
            ? (ambiguous ? "Réponse entreprise à vérifier" : "Réception confirmée par l'entreprise")
            : (ambiguous ? "Réponse client à vérifier" : "Paiement signalé par le client")}
        </span>
        <span className="text-[10px] text-muted-foreground">{new Date(suggestion.emailDate).toLocaleDateString("fr-FR")}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Réponse de <span className="font-semibold text-foreground">{suggestion.senderEmail}</span>
        {suggestion.matchedExcerpt && (
          <>
            {" — «\u00A0"}
            <span className="italic" data-testid={`text-suggestion-excerpt-${suggestion.id}`}>{suggestion.matchedExcerpt}</span>
            {"\u00A0»"}
          </>
        )}
        {ambiguous && " — aucun mot-clé de paiement détecté, à vérifier manuellement."}
      </p>
      <div className="grid grid-cols-3 gap-2">
        <Input type="date" value={datePaid} onChange={(e) => setDatePaid(e.target.value)} data-testid={`input-suggestion-date-${suggestion.id}`} />
        <Input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid={`input-suggestion-amount-${suggestion.id}`} />
        <Select value={method} onValueChange={(v) => setMethod(v as "virement" | "cheque" | "autre")}>
          <SelectTrigger data-testid={`select-suggestion-method-${suggestion.id}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="virement">Virement</SelectItem>
            <SelectItem value="cheque">Chèque</SelectItem>
            <SelectItem value="autre">Autre</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dismissMutation.mutate()}
          disabled={dismissMutation.isPending || confirmMutation.isPending}
          data-testid={`button-dismiss-suggestion-${suggestion.id}`}
        >
          <span className="text-[8px] font-bold uppercase tracking-widest">Ignorer</span>
        </Button>
        <Button
          size="sm"
          onClick={() => confirmMutation.mutate()}
          disabled={confirmMutation.isPending || dismissMutation.isPending || !datePaid || !amount || parseFloat(amount) <= 0}
          data-testid={`button-confirm-suggestion-${suggestion.id}`}
        >
          <span className="text-[8px] font-bold uppercase tracking-widest">Confirmer le paiement</span>
        </Button>
      </div>
    </div>
  );
}

// Task #465 — structured client-payment ledger on the certificat detail.
export function CertificatPaymentsSection({ cert, initialInvoiceId }: { cert: Certificat; initialInvoiceId?: number }) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [datePaid, setDatePaid] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"virement" | "cheque" | "autre">("virement");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [allocationAmounts, setAllocationAmounts] = useState<Record<number, string>>({});
  const requestId = useRef<string | null>(null);
  const [evidencePayment, setEvidencePayment] = useState<PaymentWithEvidence | null>(null);
  const [proofTarget, setProofTarget] = useState<number | null>(null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const closeEvidence = useCallback(() => setEvidencePayment(null), []);
  const context = useCertificatPaymentContext(cert.id);
  const invoices = context.data?.invoices ?? [];
  const currentCert = context.data?.cert ?? cert;
  const blockedReason = paymentStateReason(currentCert.status, context.data?.archived ?? false);
  const canWrite = !!context.data && !blockedReason;
  const invoiceAllocations = invoices.length === 1
    ? [{ invoiceId: invoices[0].id, amount }]
    : invoices.map((invoice) => ({
      invoiceId: invoice.id,
      amount: allocationAmounts[invoice.id] ?? (invoice.id === initialInvoiceId ? amount : "0"),
    })).filter((item) => Number(item.amount) > 0);
  const allocationsValid = invoices.length < 2 || (
    Object.values(allocationAmounts).every((value) => Number.isFinite(Number(value)) && Number(value) >= 0)
    && allocationsMatch(amount, invoiceAllocations)
  );

  const ledgerKey = ["/api/certificats", String(cert.id), "payments"];
  const { data: ledger, isLoading: ledgerLoading, error: ledgerError, refetch: refetchLedger } = useQuery<PaymentLedgerResponse>({ queryKey: ledgerKey });

  // Task #466 — draft suggestions detected from client "paid" replies.
  const suggestionsKey = ["/api/certificats", String(cert.id), "payment-suggestions"];
  const { data: suggestions } = useQuery<CertificatPaymentSuggestion[]>({ queryKey: suggestionsKey });
  const openSuggestions = (suggestions ?? []).filter((s) => s.status === "pending_review" || s.status === "ambiguous");

  // Task #590 — shared helper covers the ledger, suggestions, project
  // certificat lists, financial summary and dashboard, so a paid flip is
  // visible everywhere without a manual reload.
  const invalidate = () => invalidateCertificatPaymentData();

  const resetForm = () => {
    saveMutation.reset();
    setEditingId(null);
    setFormOpen(false);
    setDatePaid("");
    setAmount("");
    setMethod("virement");
    setReference("");
    setNote("");
    setFile(null);
    setFileError(null);
    setAllocationAmounts({});
    requestId.current = null;
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!canWrite || ledger?.fullyPaid) throw new Error(blockedReason ?? "La correction monétaire de ce certificat est verrouillée.");
      if (!allocationsValid) throw new Error("La somme des affectations doit correspondre au montant TTC du paiement.");
      const body = {
        datePaid,
        amount,
        method,
        reference: reference.trim() ? reference.trim() : null,
        note: note.trim() || null,
        invoiceAllocations,
        requestId: requestId.current ?? (requestId.current = crypto.randomUUID()),
      };
      const multipart = new FormData();
      multipart.append("data", JSON.stringify(body));
      if (file) multipart.append("file", file);
      const res = editingId
        ? await apiRequest("PATCH", `/api/certificat-payments/${editingId}`, body)
        : await apiRequest("POST", `/api/certificats/${cert.id}/payments`, multipart);
      return res.json() as Promise<{ overpaid: boolean; fullyPaid: boolean }>;
    },
    onSuccess: (r) => {
      invalidate();
      resetForm();
      if (r.overpaid) {
        toast({ title: "Paiement client enregistré — dépassement", description: "Le total enregistré dépasse le montant TTC du certificat.", variant: "destructive" });
      } else if (r.fullyPaid) {
        toast({ title: "Paiement client enregistré", description: "Le total enregistré couvre le certificat. Cela ne confirme pas la réception par l'entreprise." });
      } else {
        toast({ title: "Paiement enregistré" });
      }
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!canWrite || ledger?.fullyPaid) throw new Error(blockedReason ?? "La correction monétaire de ce certificat est verrouillée.");
      return (await apiRequest("DELETE", `/api/certificat-payments/${id}`)).json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Paiement supprimé" });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });
  const proofMutation = useMutation({
    mutationFn: async () => {
      if (!canWrite || !proofTarget || !proofFile) throw new Error(blockedReason ?? "Choisissez un PDF.");
      const validation = evidenceFileError(proofFile);
      if (validation) throw new Error(validation);
      const data = new FormData();
      data.append("file", proofFile);
      return (await apiRequest("POST", `/api/certificat-payments/${proofTarget}/evidence`, data)).json();
    },
    onSuccess: () => {
      invalidate();
      setProofTarget(null);
      setProofFile(null);
      setProofError(null);
      toast({ title: "Justificatif ajouté", description: "Le montant du paiement et la réception par l'entreprise sont inchangés." });
    },
    onError: (error: Error) => setProofError(error.message),
  });

  const methodLabel: Record<string, string> = { virement: "Virement", cheque: "Chèque", autre: "Autre" };
  const locked = ledger?.fullyPaid ?? false;
  const paymentRequirements: ActionRequirement[] = [
    ...(!context.data || context.error || !ledger || ledgerError ? [{
      id: "ledger", kind: context.error || ledgerError ? "technical" as const : "waiting" as const,
      message: context.error || ledgerError ? "Payment context or ledger unavailable. No payment can be recorded until both are loaded." : "Checking the payment context and shared ledger.",
      onResolve: () => { void context.refetch(); void refetchLedger(); }, linkLabel: "Retry payment status",
    }] : []),
    ...(blockedReason ? [{ id: "status", kind: "readonly" as const, message: context.data?.archived ? "The project is archived. Restore it before recording payments." : "The certificate must be issued and open for payment recording. Review its status before continuing." }] : []),
    ...(locked ? [{ id: "paid", kind: "readonly" as const, message: "The certificate is fully paid. Monetary changes are locked; existing evidence remains available." }] : []),
  ];

  return (
    <div className="space-y-3 p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]" data-testid="section-cert-payments">
      <div className="flex items-center justify-between gap-2">
        <TechnicalLabel>Paiements Client</TechnicalLabel>
        {(
          <BlockedAction
            actionLabel="Before recording a client payment"
            requirements={paymentRequirements}
            variant="outline"
            size="sm"
            disabled={saveMutation.isPending}
            onClick={() => {
              resetForm();
              setFormOpen(true);
              setDatePaid(new Date().toISOString().split("T")[0]);
              // Task #627 — pre-fill the reference field with the frozen
              // bank-transfer reference so the architect doesn't have to
              // copy it manually from the PDF.
              if (cert.paymentTransferRef) setReference(cert.paymentTransferRef);
            }}
            data-testid="button-log-payment"
          >
            <Plus size={11} />
            <span className="text-[8px] font-bold uppercase tracking-widest">Enregistrer un paiement client</span>
          </BlockedAction>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">Journal partagé avec le certificat. Paiements partiels possibles. Un justificatif ne confirme pas la réception des fonds par l'entreprise.</p>
      {blockedReason && <p className="text-[11px] text-amber-800 dark:text-amber-300" role="status">{blockedReason}</p>}
      {(ledgerLoading || context.isLoading) && <Skeleton className="h-12 w-full" />}
      {(ledgerError || context.error) && <div role="alert" className="text-[11px] text-destructive">Impossible de charger le journal. <Button variant="ghost" size="sm" onClick={() => { void refetchLedger(); void context.refetch(); }}>Réessayer</Button></div>}

      {ledger && (
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-muted-foreground">
            Paiements client enregistrés <span className="font-semibold text-foreground" data-testid="text-cert-paid-to-date">{<Amount value={ledger.paidToDate} denomination="TTC" />}</span>
            {" / "}{<Amount value={parseFloat(cert.netToPayTtc)} denomination="TTC" />}
          </span>
          {ledger.overpaid ? (
            <span className="text-[10px] font-bold uppercase tracking-widest text-red-600 dark:text-red-400" data-testid="badge-cert-overpaid">Trop-perçu</span>
          ) : ledger.fullyPaid ? (
            <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400" data-testid="badge-cert-fully-paid">Soldé</span>
          ) : (
            <span className="text-muted-foreground" data-testid="text-cert-outstanding">Reste dû {<Amount value={ledger.outstanding} denomination="TTC" />}</span>
          )}
        </div>
      )}

      {canWrite && !locked && openSuggestions.map((s) => (
        <PaymentSuggestionCard key={s.id} suggestion={s} onDone={invalidate} />
      ))}

      {(ledger?.payments ?? []).map((p) => (
        <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-[12px] border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-2" data-testid={`row-payment-${p.id}`}>
          <div>
            <span className="font-semibold text-foreground">{<Amount value={parseFloat(p.amount)} denomination="TTC" />}</span>
            <span className="text-muted-foreground"> — {methodLabel[p.method] ?? p.method} le {p.datePaid}</span>
            {p.reference && <span className="text-[10px] text-muted-foreground italic"> (réf. {p.reference})</span>}
            {p.note && <p className="text-[11px] text-muted-foreground whitespace-pre-wrap">{p.note}</p>}
            {!!p.invoiceAllocations?.length && <p className="text-[10px] text-muted-foreground">{p.invoiceAllocations.map((allocation) => `Facture #${invoices.find((invoice) => invoice.id === allocation.invoiceId)?.invoiceNumber ?? allocation.invoiceId} : ${fmt(Number(allocation.amount))}`).join(" · ")}</p>}
            {p.evidenceFileName ? <Button variant="ghost" size="sm" onClick={() => setEvidencePayment(p)} data-testid={`button-payment-evidence-${p.id}`}>Justificatif PDF — {p.evidenceFileName}</Button>
              : canWrite && <Button variant="outline" size="sm" disabled={proofMutation.isPending} onClick={() => { setProofTarget(p.id); setProofFile(null); setProofError(null); }} data-testid={`button-add-payment-evidence-${p.id}`}>Ajouter un justificatif PDF</Button>}
          </div>
          {!locked && canWrite && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  resetForm();
                  setEditingId(p.id);
                  setFormOpen(true);
                  setDatePaid(p.datePaid);
                  setAmount(p.amount);
                  setMethod((p.method as "virement" | "cheque" | "autre") ?? "virement");
                  setReference(p.reference ?? "");
                  setNote(p.note ?? "");
                  setAllocationAmounts(Object.fromEntries(invoices.map((invoice) => [invoice.id, String(p.invoiceAllocations?.find((allocation) => allocation.invoiceId === invoice.id)?.amount ?? 0)])));
                }}
                data-testid={`button-edit-payment-${p.id}`}
              >
                <span className="text-[8px] font-bold uppercase tracking-widest">Corriger</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { if (window.confirm("Supprimer ce paiement du journal ? Le justificatif et l'historique sont conservés pour audit.")) deleteMutation.mutate(p.id); }}
                disabled={deleteMutation.isPending}
                data-testid={`button-delete-payment-${p.id}`}
              >
                <span className="text-[8px] font-bold uppercase tracking-widest text-red-600 dark:text-red-400">Suppr.</span>
              </Button>
            </div>
          )}
        </div>
      ))}
      {proofTarget !== null && <div className="space-y-2 rounded-lg border border-border p-3" data-testid="form-payment-evidence">
        <p className="text-[11px] font-semibold">Ajouter le justificatif au paiement existant — aucun nouveau paiement</p>
        <Input aria-label="Justificatif PDF du paiement existant" type="file" accept="application/pdf,.pdf" disabled={proofMutation.isPending} onChange={(event) => {
          const selected = event.target.files?.[0] ?? null;
          const error = selected ? evidenceFileError(selected) : null;
          setProofError(error); setProofFile(error ? null : selected);
        }} />
        <p className="text-[10px] text-muted-foreground">PDF, 10 Mo maximum. Le justificatif sera conservé pour audit.</p>
        {proofError && <p role="alert" className="text-[11px] text-destructive">{proofError}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={proofMutation.isPending} onClick={() => { setProofTarget(null); setProofFile(null); setProofError(null); }}>Annuler</Button>
          <Button size="sm" disabled={!canWrite || !proofFile || proofMutation.isPending} onClick={() => proofMutation.mutate()}>{proofMutation.isPending ? "Enregistrement…" : "Ajouter le justificatif"}</Button>
        </div>
      </div>}
      {(ledger?.audits ?? []).filter((audit) => audit.action === "deleted").map((audit) => <div key={audit.id} className="rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground" data-testid={`audit-deleted-payment-${audit.paymentId}`}>
        Paiement supprimé — {audit.snapshot?.amount && fmt(Number(audit.snapshot.amount))} · {new Date(audit.createdAt).toLocaleDateString("fr-FR")}
        {audit.snapshot?.note && <p className="whitespace-pre-wrap">{audit.snapshot.note}</p>}
        {audit.snapshot?.evidenceFileName && <Button variant="ghost" size="sm" onClick={() => setEvidencePayment({ ...audit.snapshot!, id: audit.paymentId })}>Justificatif conservé — {audit.snapshot.evidenceFileName}</Button>}
      </div>)}
      {evidencePayment && <PdfPopoutViewer pdfUrl={`/api/certificat-payments/${evidencePayment.id}/evidence`} downloadUrl={`/api/certificat-payments/${evidencePayment.id}/evidence`} downloadName={evidencePayment.evidenceFileName ?? "justificatif.pdf"} devisCode={`Justificatif — ${currentCert.certificateRef}`} viewerId={`payment-evidence-${evidencePayment.id}`} onClose={closeEvidence} />}

      {ledger && ledger.payments.length === 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="text-no-payments">
          {cert.status === "paid" ? "Certificat marqué payé avant la mise en place du journal des paiements." : "Aucun paiement enregistré."}
        </p>
      )}

      {formOpen && canWrite && !locked && (
        <fieldset disabled={saveMutation.isPending} className="space-y-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-3" data-testid="form-payment">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <TechnicalLabel>Date de paiement</TechnicalLabel>
              <Input type="date" value={datePaid} onChange={(e) => setDatePaid(e.target.value)} data-testid="input-payment-date" />
            </div>
            <div>
              <TechnicalLabel>Montant TTC (€)</TechnicalLabel>
              <Input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="input-payment-amount" />
            </div>
          </div>
          <div>
            <TechnicalLabel>Note (optionnelle)</TechnicalLabel>
            <Textarea aria-label="Note du paiement" value={note} onChange={(event) => setNote(event.target.value)} data-testid="input-payment-note" />
          </div>
          {invoices.length > 1 && <fieldset className="space-y-2 rounded-md bg-muted/40 p-3">
            <legend className="text-[11px] font-semibold">Affectation aux factures (TTC)</legend>
            {invoices.map((invoice) => <label key={invoice.id} className="flex items-center justify-between gap-3 text-[11px]">
              <span>Facture #{invoice.invoiceNumber} · {fmt(Number(invoice.amountTtc))}</span>
              <Input className="max-w-36" data-testid="input-payment-allocation" aria-label={`Affectation facture ${invoice.invoiceNumber}`} type="number" step="0.01" min="0" value={allocationAmounts[invoice.id] ?? (invoice.id === initialInvoiceId ? amount : "0")} onChange={(event) => setAllocationAmounts((previous) => ({ ...previous, [invoice.id]: event.target.value }))} />
            </label>)}
            {!allocationsValid && <p className="text-[11px] text-destructive" role="alert">La somme des affectations doit être égale au montant TTC du paiement.</p>}
          </fieldset>}
          {!editingId && <div className="space-y-1">
            <TechnicalLabel>Justificatif PDF (optionnel, 10 Mo maximum)</TechnicalLabel>
            <Input aria-label="Justificatif PDF" type="file" accept="application/pdf,.pdf" disabled={saveMutation.isPending} onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              const error = selected ? evidenceFileError(selected) : null;
              setFileError(error); setFile(error ? null : selected);
            }} data-testid="input-payment-evidence" />
            {file && <p className="text-[10px] text-muted-foreground">{file.name} — conservé avec le paiement après enregistrement.</p>}
            {fileError && <p role="alert" className="text-[11px] text-destructive">{fileError}</p>}
          </div>}
          {editingId && <p className="text-[10px] text-muted-foreground">Le justificatif existant est conservé pour audit. Pour ajouter une preuve manquante, utilisez « Ajouter un justificatif PDF » dans le journal.</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <TechnicalLabel>Mode</TechnicalLabel>
              <Select value={method} onValueChange={(v) => setMethod(v as "virement" | "cheque" | "autre")}>
                <SelectTrigger data-testid="select-payment-method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="virement">Virement</SelectItem>
                  <SelectItem value="cheque">Chèque</SelectItem>
                  <SelectItem value="autre">Autre</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <TechnicalLabel>Référence (optionnel)</TechnicalLabel>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ex: VIR-2026-081" data-testid="input-payment-reference" />
            </div>
          </div>
          {saveMutation.error && <p role="alert" className="text-[11px] text-destructive">{saveMutation.error.message} Le formulaire et le justificatif sont conservés. Vous pouvez réessayer.</p>}
          <div className="flex items-center gap-2 justify-end">
            <Button variant="ghost" size="sm" disabled={saveMutation.isPending} onClick={resetForm} data-testid="button-cancel-payment">
              <span className="text-[8px] font-bold uppercase tracking-widest">Annuler</span>
            </Button>
            <BlockedAction
              actionLabel="Before saving this payment"
              requirements={[
                ...paymentRequirements,
                ...(!datePaid ? [{ id: "date", message: "Choose the payment date.", onResolve: () => focusActionTarget('[data-testid="input-payment-date"]'), linkLabel: "Go to payment date" }] : []),
                ...(!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0 ? [{ id: "amount", message: "Enter a finite payment amount greater than zero.", onResolve: () => focusActionTarget('[data-testid="input-payment-amount"]'), linkLabel: "Go to payment amount" }] : []),
                ...(!allocationsValid ? [{ id: "allocations", message: "Invoice allocations must match the payment amount.", onResolve: () => focusActionTarget('[data-testid="input-payment-allocation"]'), linkLabel: "Go to allocations" }] : []),
                ...(fileError ? [{ id: "evidence", message: "Choose a valid PDF payment proof within the size limit.", onResolve: () => focusActionTarget('[data-testid="input-payment-evidence"]'), linkLabel: "Go to payment proof" }] : []),
              ]}
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              data-testid="button-save-payment"
            >
              <span className="text-[8px] font-bold uppercase tracking-widest">{editingId ? "Corriger" : "Enregistrer"}</span>
            </BlockedAction>
          </div>
        </fieldset>
      )}
    </div>
  );
}

export function CertificatDetailDialog({ cert, contractor, onClose }: { cert: CertificatWithSupplierPresentation; contractor?: Contractor; onClose: () => void }) {
  const { toast } = useToast();
  const [sentEvidence, setSentEvidence] = useState({
    sentAt: cert.sentAt ?? null,
    sentToEmail: cert.sentToEmail ?? null,
  });
  const deliveryCert = { ...cert, ...sentEvidence };
  const delivered = hasCertificatDeliveryEvidence(deliveryCert);
  const falseSent = isFalseSentCertificat(deliveryCert);
  const isSupplier = cert.certificateTrack === "supplier_direct_payment";
  const { data: sources, isLoading: sourcesLoading, error: sourcesError } = useQuery<CertificatSource[]>({
    queryKey: ["/api/certificats", String(cert.id), "sources"],
    enabled: isSupplier,
  });
  const sendMutation = useInvoiceAwareCertificatSend<{ sentAt?: string | null; recipientEmail?: string | null }>({
    target: () => ({ projectId: cert.projectId, certId: cert.id }),
    onSuccess: (communication) => {
      setSentEvidence({
        sentAt: communication.sentAt ?? new Date().toISOString(),
        sentToEmail: communication.recipientEmail ?? null,
      });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(cert.projectId, "certificats") });
      queryClient.invalidateQueries({ queryKey: projectScopedKey(cert.projectId, "communications") });
      queryClient.invalidateQueries({ queryKey: ["/api/certificats/unsent"] });
      toast({ title: "Certificat sent", description: cert.certificateRef });
    },
    onError: (error: Error) => {
      toast({ title: "Send failed", description: error.message, variant: "destructive" });
    },
  });
  return (
    <Dialog open modal={false} onOpenChange={onClose}>
      {/* Keep the existing backdrop while allowing the separate PDF window to receive focus. */}
      <DialogPortal><div aria-hidden="true" className="fixed inset-0 z-50 bg-black/80" /></DialogPortal>
      {sendMutation.confirmationDialog}
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" onInteractOutside={(event) => {
        if ((event.target as HTMLElement)?.closest?.('[data-testid^="dialog-pdf-popout-payment-evidence-"]')) event.preventDefault();
      }}>
        <DialogHeader>
          <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
            {isSupplier
              ? `Paiement direct fournisseur — ${cert.certificateRef}`
              : `Certificat ${cert.certificateRef}`}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isSupplier
              ? "Détail du paiement direct fournisseur et de ses factures sources."
              : "Détail du certificat et de son suivi de paiement."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <PennylaneInvoiceDescription certId={cert.id} />
          <ArchitectInvoiceSection certId={cert.id} />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <StatusBadge status={cert.status} />
            {falseSent && (
              <span
                className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                data-testid={`badge-cert-detail-not-emailed-${cert.id}`}
              >
                Not emailed
              </span>
            )}
            {isSupplier && <span className="rounded-full border border-emerald-700/30 bg-emerald-700/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-emerald-800" data-testid={`badge-certificate-track-${cert.id}`}>Paiement direct fournisseur</span>}
            <div className="flex items-center gap-3">
              {cert.driveWebViewLink && (
                <a
                  href={cert.driveWebViewLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-widest text-emerald-800 hover:underline"
                  data-testid={`link-cert-drive-${cert.id}`}
                  title="Open in Renosud shared Drive"
                >
                  <ExternalLink size={11} /> Drive
                </a>
              )}
              {cert.dateIssued && (
                <span className="text-[11px] text-muted-foreground" data-testid="text-cert-detail-date">
                  {cert.dateIssued}
                </span>
              )}
            </div>
          </div>

          {delivered && (
            <div
              className="rounded-md border border-emerald-300/70 bg-emerald-50/70 px-3 py-2 text-[11px] text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-950/20 dark:text-emerald-200"
              data-testid={`notice-cert-detail-delivered-${cert.id}`}
            >
              Sent to <span className="font-semibold">{deliveryCert.sentToEmail}</span> on{" "}
              {new Date(deliveryCert.sentAt!).toLocaleString("fr-FR")}.
            </div>
          )}

          {(
            <div
              className="flex items-center justify-between gap-3 rounded-md border border-amber-300/70 bg-amber-50/70 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-950/20"
              data-testid={`notice-cert-detail-awaiting-email-${cert.id}`}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                  {falseSent
                    ? "This certificat was marked Sent, but no delivered email exists. Its sealed figures are unchanged and it can be sent now."
                    : "This certificat has not been emailed to the client yet."}
                </p>
              </div>
              <BlockedAction
                actionLabel="Before sending this certificate"
                requirements={certificateSendRequirements(deliveryCert).map(requirement => requirement.id === "ready" ? { ...requirement, href: `/certificats?projectId=${cert.projectId}&certificatId=${cert.id}`, linkLabel: "Go to certificate review" } : requirement)}
                size="sm"
                onClick={() => sendMutation.mutate(undefined)}
                disabled={sendMutation.isPending}
                data-testid={`button-send-cert-detail-${cert.id}`}
              >
                {sendMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                <span className="text-[8px] font-bold uppercase tracking-widest">Send</span>
              </BlockedAction>
            </div>
          )}

          {cert.status === "draft" && !cert.driveWebViewLink && (
            <div
              className="flex items-start gap-2 rounded-md border border-sky-300/70 dark:border-sky-600/30 bg-sky-50/70 dark:bg-sky-950/20 px-3 py-2"
              data-testid="notice-cert-draft-no-pdf"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-sky-600 dark:text-sky-400" />
              <p className="text-[11px] text-sky-800 dark:text-sky-300 leading-snug">
                Brouillon — aucun PDF généré pour l'instant. Le document sera disponible une fois le certificat émis.
              </p>
            </div>
          )}

          {contractor && (
            <div>
              <TechnicalLabel>{isSupplier ? "Fournisseur" : "Contractor"}</TechnicalLabel>
              <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-cert-detail-contractor">
                {isSupplier
                  ? cert.supplierPresentation?.supplier.name ??
                    contractor.name
                  : contractor.name}
              </p>
            </div>
          )}

          {/* Task #487 — non-blocking BIC warning in the detail dialog */}
          {!isSupplier && contractor && !contractor.bic && (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-300/70 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2"
              data-testid="warning-bic-missing-detail"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                <span className="font-semibold">{contractor.name}</span> has no SWIFT/BIC on file — the certificat
                prints &quot;NON COMMUNIQUÉ PAR L&apos;ÉTABLISSEMENT&quot; in the payment panel.{" "}
                <a
                  href="/contractors"
                  className="underline font-semibold hover:opacity-80"
                  data-testid="link-bic-missing-detail"
                >
                  Manage banking details
                </a>
              </p>
            </div>
          )}

          {isSupplier ? (
            <div className="space-y-3 p-4 rounded-xl border border-emerald-700/20 bg-emerald-50/30" data-testid="supplier-readiness-summary">
              <TechnicalLabel>Factures sources du paiement direct</TechnicalLabel>
              {sourcesLoading ? <p className="text-[11px] text-muted-foreground">Chargement des factures sources…</p> : sourcesError ? <p className="text-[11px] text-destructive">{(sourcesError as Error).message}</p> : (sources ?? []).length ? (
                (sources ?? []).map((source) => source.invoice && (
                  <div className="border-t border-emerald-700/15 pt-2" key={source.invoice.id} data-testid={`supplier-source-row-${source.invoice.id}`}>
                    <div className="flex justify-between gap-3 text-[12px]"><span className="font-semibold">Facture #{source.invoice.invoiceNumber}</span><span className="text-muted-foreground">{source.invoice.dateIssued ? new Date(`${source.invoice.dateIssued}T12:00:00`).toLocaleDateString("fr-FR") : "Date non communiquée"}</span></div>
                    <div className="mt-1 flex justify-between gap-2 text-[11px] tabular-nums"><Amount value={parseFloat(source.invoice.amountHt)} denomination="HT" /><Amount value={parseFloat(source.invoice.tvaAmount ?? "0")} denomination="TVA" /><Amount value={parseFloat(source.invoice.amountTtc)} denomination="TTC" /></div>
                  </div>
                ))
              ) : <p className="text-[11px] text-muted-foreground">Aucune facture source disponible.</p>}
              <div className="space-y-1 border-t border-emerald-700/15 pt-3">
                <div className="flex items-center justify-between"><TechnicalLabel>Total HT</TechnicalLabel><Amount value={parseFloat(cert.netToPayHt)} denomination="HT" /></div>
                <div className="flex items-center justify-between"><TechnicalLabel>Total TVA</TechnicalLabel><Amount value={parseFloat(cert.tvaAmount)} denomination="TVA" /></div>
                <div className="flex items-center justify-between"><TechnicalLabel>Total à payer TTC</TechnicalLabel><span className="text-[16px] font-bold"><Amount value={parseFloat(cert.netToPayTtc)} denomination="TTC" /></span></div>
                {cert.paymentTransferRef && (
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <TechnicalLabel>Référence du virement</TechnicalLabel>
                    <span className="font-mono text-[12px] font-semibold" data-testid="supplier-transfer-reference">{cert.paymentTransferRef}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
          <div className="space-y-3 p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
            <div className="flex items-center justify-between gap-2">
              <TechnicalLabel>Total Works HT</TechnicalLabel>
              <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-works">
                {<Amount value={parseFloat(cert.totalWorksHt)} denomination="HT" />}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <TechnicalLabel>PV/MV Adjustment HT</TechnicalLabel>
              <span className={`text-[13px] font-semibold ${parseFloat(cert.pvMvAdjustment ?? "0") >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} data-testid="text-cert-detail-pvmv">
                {<Amount value={parseFloat(cert.pvMvAdjustment ?? "0")} denomination="HT" />}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <TechnicalLabel>Previous Payments HT</TechnicalLabel>
              <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-previous">
                {<Amount value={parseFloat(cert.previousPayments ?? "0")} denomination="HT" />}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <TechnicalLabel>Retenue de Garantie HT</TechnicalLabel>
              <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-retenue">
                {<Amount value={parseFloat(cert.retenueGarantie ?? "0")} denomination="HT" />}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <TechnicalLabel>Compte Prorata HT</TechnicalLabel>
              <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-prorata">
                {<Amount value={parseFloat(cert.cumulativeProrataDeduction ?? "0")} denomination="HT" />}
              </span>
            </div>
            {parseFloat(cert.cumulativeAcompteRecoupment ?? "0") > 0 && (
              <div className="flex items-center justify-between gap-2">
                <TechnicalLabel>Remboursement d'Acompte HT (période / cumul)</TechnicalLabel>
                <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-acompte-recoupment">
                  <Amount value={parseFloat(cert.periodAcompteRecoupment ?? "0")} denomination="HT" /> / <Amount value={parseFloat(cert.cumulativeAcompteRecoupment ?? "0")} denomination="HT" />
                </span>
              </div>
            )}
            {cert.isSolde && (
              <div className="flex items-center justify-between gap-2" data-testid="text-cert-detail-solde">
                <TechnicalLabel>Certificat de Solde</TechnicalLabel>
                <span className="text-[13px] font-semibold text-foreground">
                  {cert.retenueReleased
                    ? `RG libérée ${fmt(parseFloat(cert.retenueReleaseAmount ?? "0"))} HT${cert.retenueReleaseDate ? ` le ${cert.retenueReleaseDate}` : ""}`
                    : "Retenue de Garantie conservée"}
                </span>
              </div>
            )}
            {cert.isSolde && cert.retenueReleased && cert.retenueReleaseReason && (
              <div className="text-[10px] text-muted-foreground italic" data-testid="text-cert-detail-release-reason">
                Raison : {cert.retenueReleaseReason}
              </div>
            )}
            <div className="border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-3">
              <div className="flex items-center justify-between gap-2">
                <TechnicalLabel>Net to Pay HT</TechnicalLabel>
                <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-net-ht">
                  {<Amount value={parseFloat(cert.netToPayHt)} denomination="HT" />}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 mt-1">
                <TechnicalLabel>
                  {cert.tvaRateSource === "documentary"
                    ? `TVA (taux effectif ${parseFloat(cert.tvaRatePercent ?? "20")}%)`
                    : `TVA (${parseFloat(cert.tvaRatePercent ?? "20")}%${cert.tvaAutoliquidation ? " — autoliquidation" : ""})`}
                </TechnicalLabel>
                <span className="text-[13px] font-semibold text-foreground" data-testid="text-cert-detail-tva">
                  {<Amount value={parseFloat(cert.tvaAmount)} denomination="TVA" />}
                </span>
              </div>
              {cert.tvaAutoliquidation && (
                <div className="text-[10px] text-muted-foreground italic mt-1" data-testid="text-cert-detail-autoliquidation">
                  Autoliquidation — TVA due par le preneur (art. 283 CGI)
                </div>
              )}
              {cert.tvaEvidenceKind === "signed_quotation" && cert.tvaEvidenceDevisId != null && cert.tvaEvidenceDevisReference ? (
                <div className="flex items-center justify-between gap-2 mt-1" data-testid="text-cert-detail-tva-evidence">
                  <TechnicalLabel>Justificatif TVA</TechnicalLabel>
                  <a
                    href={`/projets/${cert.projectId}?tab=devis&devis=${cert.tvaEvidenceDevisId}`}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
                    data-testid="link-cert-detail-tva-devis"
                  >
                    Devis signé {cert.tvaEvidenceDevisReference}
                    <ExternalLink size={11} />
                  </a>
                </div>
              ) : cert.tvaEvidenceKind === "legacy" ||
                (cert.tvaEvidenceKind === "signed_quotation" && !cert.tvaEvidenceDevisReference) ? (
                <div className="flex items-center justify-between gap-2 mt-1" data-testid="text-cert-detail-tva-evidence-legacy">
                  <TechnicalLabel>Justificatif TVA</TechnicalLabel>
                  <span className="text-[10px] italic text-muted-foreground">
                    Preuve historique — devis non lié
                  </span>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                <span className="text-[11px] font-black uppercase tracking-widest text-foreground">Net to Pay TTC</span>
                <span className="text-[16px] font-bold text-foreground" data-testid="text-cert-detail-net-ttc">
                  {<Amount value={parseFloat(cert.netToPayTtc)} denomination="TTC" />}
                </span>
              </div>
            </div>
          </div>
          )}

          {cert.paymentTransferRef && (
            <div
              className="flex items-center justify-between gap-2 p-3 rounded-lg border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]"
              data-testid="section-transfer-ref"
            >
              <div className="min-w-0">
                <TechnicalLabel>Référence de virement</TechnicalLabel>
                <p
                  className="text-[13px] font-mono font-semibold text-foreground mt-0.5 truncate"
                  data-testid="text-transfer-ref"
                >
                  {cert.paymentTransferRef}
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText(cert.paymentTransferRef!);
                  toast({ title: "Référence copiée" });
                }}
                data-testid="button-copy-transfer-ref"
                title="Copier la référence"
              >
                <Copy size={12} />
                Copier
              </button>
            </div>
          )}

          {cert.status !== "draft" && <CertificatPaymentsSection cert={cert} />}

          {cert.notes && (
            <div>
              <TechnicalLabel>Notes</TechnicalLabel>
              <p className="text-[12px] text-muted-foreground mt-1" data-testid="text-cert-detail-notes">{cert.notes}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
