/**
 * Task #573 — shared CertificatDetailDialog with full payment capability.
 *
 * Extracted from the /certificats page so the same payment-capable dialog
 * (Paiements Client section: ledger, suggestions, register/edit/delete) can
 * be opened from within a project's Certificats tab too.
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExternalLink, AlertTriangle, Plus } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, invalidateCertificatPaymentData } from "@/lib/queryClient";
import type { Certificat, Contractor, CertificatPayment, CertificatPaymentSuggestion } from "@shared/schema";

import { Amount } from "@/components/ui/amount";
import { formatCurrency as fmt } from "@/lib/utils";

interface PaymentLedgerResponse {
  payments: CertificatPayment[];
  paidToDate: number;
  outstanding: number;
  fullyPaid: boolean;
  overpaid: boolean;
}

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
export function CertificatPaymentsSection({ cert }: { cert: Certificat }) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [datePaid, setDatePaid] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"virement" | "cheque" | "autre">("virement");
  const [reference, setReference] = useState("");

  const ledgerKey = ["/api/certificats", String(cert.id), "payments"];
  const { data: ledger } = useQuery<PaymentLedgerResponse>({ queryKey: ledgerKey });

  // Task #466 — draft suggestions detected from client "paid" replies.
  const suggestionsKey = ["/api/certificats", String(cert.id), "payment-suggestions"];
  const { data: suggestions } = useQuery<CertificatPaymentSuggestion[]>({ queryKey: suggestionsKey });
  const openSuggestions = (suggestions ?? []).filter((s) => s.status === "pending_review" || s.status === "ambiguous");

  // Task #590 — shared helper covers the ledger, suggestions, project
  // certificat lists, financial summary and dashboard, so a paid flip is
  // visible everywhere without a manual reload.
  const invalidate = () => invalidateCertificatPaymentData();

  const resetForm = () => {
    setEditingId(null);
    setFormOpen(false);
    setDatePaid("");
    setAmount("");
    setMethod("virement");
    setReference("");
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        datePaid,
        amount,
        method,
        reference: reference.trim() ? reference.trim() : null,
      };
      const res = editingId
        ? await apiRequest("PATCH", `/api/certificat-payments/${editingId}`, body)
        : await apiRequest("POST", `/api/certificats/${cert.id}/payments`, body);
      return res.json() as Promise<{ overpaid: boolean; fullyPaid: boolean }>;
    },
    onSuccess: (r) => {
      invalidate();
      resetForm();
      if (r.overpaid) {
        toast({ title: "Paiement enregistré — trop-perçu", description: "Le total encaissé dépasse le montant TTC du certificat.", variant: "destructive" });
      } else if (r.fullyPaid) {
        toast({ title: "Certificat intégralement payé", description: "Le statut est passé automatiquement à payé." });
      } else {
        toast({ title: "Paiement enregistré" });
      }
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/certificat-payments/${id}`)).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Paiement supprimé" });
    },
    onError: (error: Error) => toast({ title: "Erreur", description: error.message, variant: "destructive" }),
  });

  const methodLabel: Record<string, string> = { virement: "Virement", cheque: "Chèque", autre: "Autre" };
  const locked = ledger?.fullyPaid ?? false;

  return (
    <div className="space-y-3 p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]" data-testid="section-cert-payments">
      <div className="flex items-center justify-between gap-2">
        <TechnicalLabel>Paiements Client</TechnicalLabel>
        {!locked && cert.status !== "superseded" && (
          <Button
            variant="outline"
            size="sm"
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
            <span className="text-[8px] font-bold uppercase tracking-widest">Enregistrer un paiement</span>
          </Button>
        )}
      </div>

      {ledger && (
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-muted-foreground">
            Encaissé <span className="font-semibold text-foreground" data-testid="text-cert-paid-to-date">{<Amount value={ledger.paidToDate} denomination="TTC" />}</span>
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

      {openSuggestions.map((s) => (
        <PaymentSuggestionCard key={s.id} suggestion={s} onDone={invalidate} />
      ))}

      {(ledger?.payments ?? []).map((p) => (
        <div key={p.id} className="flex items-center justify-between gap-2 text-[12px] border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-2" data-testid={`row-payment-${p.id}`}>
          <div>
            <span className="font-semibold text-foreground">{<Amount value={parseFloat(p.amount)} denomination="TTC" />}</span>
            <span className="text-muted-foreground"> — {methodLabel[p.method] ?? p.method} le {p.datePaid}</span>
            {p.reference && <span className="text-[10px] text-muted-foreground italic"> (réf. {p.reference})</span>}
          </div>
          {!locked && cert.status !== "superseded" && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingId(p.id);
                  setFormOpen(true);
                  setDatePaid(p.datePaid);
                  setAmount(p.amount);
                  setMethod((p.method as "virement" | "cheque" | "autre") ?? "virement");
                  setReference(p.reference ?? "");
                }}
                data-testid={`button-edit-payment-${p.id}`}
              >
                <span className="text-[8px] font-bold uppercase tracking-widest">Corriger</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteMutation.mutate(p.id)}
                disabled={deleteMutation.isPending}
                data-testid={`button-delete-payment-${p.id}`}
              >
                <span className="text-[8px] font-bold uppercase tracking-widest text-red-600 dark:text-red-400">Suppr.</span>
              </Button>
            </div>
          )}
        </div>
      ))}

      {ledger && ledger.payments.length === 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="text-no-payments">
          {cert.status === "paid" ? "Certificat marqué payé avant la mise en place du journal des paiements." : "Aucun paiement enregistré."}
        </p>
      )}

      {formOpen && (
        <div className="space-y-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-3" data-testid="form-payment">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <TechnicalLabel>Date de paiement</TechnicalLabel>
              <Input type="date" value={datePaid} onChange={(e) => setDatePaid(e.target.value)} data-testid="input-payment-date" />
            </div>
            <div>
              <TechnicalLabel>Montant TTC (€)</TechnicalLabel>
              <Input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="input-payment-amount" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
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
          <div className="flex items-center gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={resetForm} data-testid="button-cancel-payment">
              <span className="text-[8px] font-bold uppercase tracking-widest">Annuler</span>
            </Button>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !datePaid || !amount || parseFloat(amount) <= 0}
              data-testid="button-save-payment"
            >
              <span className="text-[8px] font-bold uppercase tracking-widest">{editingId ? "Corriger" : "Enregistrer"}</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CertificatDetailDialog({ cert, contractor, onClose }: { cert: Certificat; contractor?: Contractor; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
            Certificat {cert.certificateRef}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <StatusBadge status={cert.status} />
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
              <TechnicalLabel>Contractor</TechnicalLabel>
              <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-cert-detail-contractor">
                {contractor.name}
              </p>
            </div>
          )}

          {/* Task #487 — non-blocking BIC warning in the detail dialog */}
          {contractor && !contractor.bic && (
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
              <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                <span className="text-[11px] font-black uppercase tracking-widest text-foreground">Net to Pay TTC</span>
                <span className="text-[16px] font-bold text-foreground" data-testid="text-cert-detail-net-ttc">
                  {<Amount value={parseFloat(cert.netToPayTtc)} denomination="TTC" />}
                </span>
              </div>
            </div>
          </div>

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
