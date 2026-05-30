import { useState } from "react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Send, Loader2, ExternalLink } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Devis } from "@shared/schema";

/**
 * AT4 Signing panel — orchestrates the §1.2 transition
 * `approved_for_signing → sent_to_client` via the Archisign envelope flow.
 *
 * Visible at every stage from `approved_for_signing` onwards so the
 * architect can see envelope status, the access URL the client will use,
 * the OTP delivery target, and the envelope's expiry.
 *
 * The "Send to signer" button is only enabled when signOffStage is
 * exactly `approved_for_signing`. Once an envelope exists we show a
 * status badge instead. Soft-invalidated access URLs (after expiry) are
 * rendered struck-through with a "resend supported in a future update"
 * note — the resend-after-expiry orchestration is intentionally out of
 * scope for AT4 itself.
 */
export function SigningPanel({
  devisId,
  isArchived,
}: {
  devisId: number;
  isArchived: boolean;
}) {
  const { toast } = useToast();
  const devisQuery = useQuery<Devis>({
    queryKey: ["/api/devis", devisId],
  });

  // Optional personalised message for the signer email — forwarded to
  // Archisign /create only on first send. The resume branch (envelopeId
  // already persisted) skips /create, so the dialog hides the input then.
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [personalMessage, setPersonalMessage] = useState("");
  const MAX_MESSAGE_LEN = 2000;

  const sendMutation = useMutation({
    mutationFn: async (message: string | undefined) => {
      const trimmed = (message ?? "").trim();
      const body = trimmed.length > 0 ? { message: trimmed } : {};
      const res = await apiRequest("POST", `/api/devis/${devisId}/send-to-signer`, body);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Envoyé à la signature",
        description: "L'enveloppe Archisign a été créée et envoyée au signataire.",
      });
      setSendDialogOpen(false);
      setPersonalMessage("");
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur d'envoi", description: error.message, variant: "destructive" });
    },
  });

  const d = devisQuery.data as (Devis & {
    archisignEnvelopeId?: string | null;
    archisignAccessUrl?: string | null;
    archisignAccessUrlInvalidatedAt?: string | null;
    archisignEnvelopeStatus?: string | null;
    archisignEnvelopeExpiresAt?: string | null;
    archisignOtpDestination?: string | null;
    archisignSignerMessage?: string | null;
    signedPdfStorageKey?: string | null;
  }) | undefined;

  if (devisQuery.isLoading || !d) {
    return (
      <LuxuryCard className="p-3" data-testid={`panel-signing-${devisId}`}>
        <Skeleton className="h-5 w-40 mb-2" />
        <Skeleton className="h-4 w-full" />
      </LuxuryCard>
    );
  }

  // Hide the panel entirely until the devis has been approved for
  // signing — earlier stages have nothing meaningful to show.
  const stage = d.signOffStage as string | null | undefined;
  const stagesShowingPanel = new Set([
    "approved_for_signing",
    "sent_to_client",
    "client_signed_off",
    "void",
  ]);
  if (!stage || !stagesShowingPanel.has(stage)) return null;

  const envelopeStatus = d.archisignEnvelopeStatus ?? null;
  const accessUrl = d.archisignAccessUrl ?? null;
  const accessUrlInvalidated = Boolean(d.archisignAccessUrlInvalidatedAt);
  const expiresAt = d.archisignEnvelopeExpiresAt ? new Date(d.archisignEnvelopeExpiresAt) : null;
  const otpDestination = d.archisignOtpDestination ?? null;

  // Gate logic — the CTA is available whenever the devis is in
  // `approved_for_signing` and not archived. This single condition naturally
  // covers all three reachable scenarios:
  //
  //   (a) FIRST SEND: no envelopeId, no accessUrl → /create + /send.
  //   (b) RESUME after a /send failure: POST /api/devis/:id/send-to-signer
  //       persists archisignEnvelopeId immediately after /create and BEFORE
  //       /send. If /send fails, the devis stays at stage
  //       `approved_for_signing` with envelopeId set; the endpoint is
  //       idempotent and resumes by re-calling /send. Gating on
  //       `!archisignEnvelopeId` would dead-end this recovery path.
  //   (c) POST-EXPIRY: handleExpired (§1.2) transitions the devis back to
  //       `approved_for_signing` and clears archisignEnvelopeId, so a click
  //       fires a fresh /create+/send. The historical accessUrl is kept
  //       struck-through alongside an "Lien expiré" note for audit context;
  //       AT4's brief excludes any *additional* resend-after-expiry
  //       orchestration (no new endpoints, no reminders), so the CTA
  //       reappearing IS the entire post-expiry surface.
  const canSend = stage === "approved_for_signing" && !isArchived;
  const isResume = canSend && !!d.archisignEnvelopeId;

  const statusLabel: Record<string, { label: string; tone: "default" | "secondary" | "destructive" }> = {
    sent: { label: "Envoyée", tone: "default" },
    viewed: { label: "Consultée", tone: "default" },
    queried: { label: "Question ouverte", tone: "secondary" },
    signed: { label: "Signée", tone: "default" },
    declined: { label: "Refusée", tone: "destructive" },
    expired: { label: "Expirée", tone: "destructive" },
  };
  const badge = envelopeStatus ? statusLabel[envelopeStatus] ?? { label: envelopeStatus, tone: "secondary" as const } : null;

  return (
    <LuxuryCard className="p-3 space-y-3 border-2 border-destructive ring-1 ring-destructive/30 shadow-[0_0_0_3px_hsl(var(--destructive)/0.08)]" data-testid={`panel-signing-${devisId}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-[#0B2545]" />
          <TechnicalLabel className="text-sm">Signature électronique</TechnicalLabel>
          {badge && (
            <Badge
              variant={badge.tone === "destructive" ? "destructive" : badge.tone === "secondary" ? "secondary" : "default"}
              data-testid={`badge-archisign-status-${devisId}`}
            >
              {badge.label}
            </Badge>
          )}
        </div>
        {canSend && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setPersonalMessage("");
              setSendDialogOpen(true);
            }}
            disabled={sendMutation.isPending}
            data-testid={`button-send-to-signer-${devisId}`}
          >
            {sendMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                {isResume ? "Reprise…" : "Envoi…"}
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-1.5" />
                {isResume ? "Réessayer l'envoi" : "Envoyer à la signature"}
              </>
            )}
          </Button>
        )}
      </div>

      <AlertDialog
        open={sendDialogOpen}
        onOpenChange={(open) => {
          if (!open && !sendMutation.isPending) {
            setSendDialogOpen(false);
          }
        }}
      >
        <AlertDialogContent data-testid={`dialog-send-to-signer-${devisId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isResume ? "Réessayer l'envoi à la signature" : "Envoyer à la signature"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isResume
                ? "L'enveloppe a déjà été créée chez Archisign — un nouvel essai relance uniquement l'envoi au signataire. Le message personnalisé saisi lors de la création initiale ne peut pas être modifié."
                : "Le signataire recevra un e-mail d'Archisign avec le lien de signature. Vous pouvez ajouter un message personnalisé (optionnel) qui sera inclus dans cet e-mail."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {!isResume && (
            <div className="space-y-2">
              <label
                htmlFor={`textarea-send-message-${devisId}`}
                className="text-sm font-medium"
              >
                Message au signataire (optionnel)
              </label>
              <Textarea
                id={`textarea-send-message-${devisId}`}
                value={personalMessage}
                onChange={(e) => setPersonalMessage(e.target.value.slice(0, MAX_MESSAGE_LEN))}
                placeholder="Bonjour, veuillez trouver ci-joint le devis pour signature électronique. N'hésitez pas à me contacter pour toute question."
                rows={5}
                maxLength={MAX_MESSAGE_LEN}
                disabled={sendMutation.isPending}
                data-testid={`textarea-send-message-${devisId}`}
              />
              <div
                className="text-xs text-muted-foreground text-right"
                data-testid={`text-send-message-count-${devisId}`}
              >
                {personalMessage.length} / {MAX_MESSAGE_LEN}
              </div>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={sendMutation.isPending}
              data-testid={`button-send-to-signer-cancel-${devisId}`}
            >
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                sendMutation.mutate(isResume ? undefined : personalMessage);
              }}
              disabled={sendMutation.isPending}
              data-testid={`button-send-to-signer-confirm-${devisId}`}
            >
              {sendMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  {isResume ? "Reprise…" : "Envoi…"}
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-1.5" />
                  {isResume ? "Réessayer l'envoi" : "Envoyer à la signature"}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {!d.archisignEnvelopeId && !accessUrl && stage === "approved_for_signing" && (
        <p className="text-xs text-muted-foreground" data-testid={`text-signing-empty-${devisId}`}>
          Aucune enveloppe Archisign créée. Le client recevra un lien de signature après envoi.
        </p>
      )}

      {/*
        Render the URL/envelope details block whenever EITHER an envelope is
        currently active OR a historical accessUrl is preserved. After an
        envelope.expired webhook, archisignEnvelopeId is nulled (so the
        Send-to-signer CTA re-arms) but archisignAccessUrl + invalidatedAt
        remain so the architect still sees the crossed-out link with the
        expiry note. Without this OR-gate, the historical link would
        disappear silently and the architect would lose context.
      */}
      {(d.archisignEnvelopeId || accessUrl) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div>
            <span className="font-semibold text-muted-foreground">Lien client :</span>{" "}
            {accessUrl ? (
              <a
                href={accessUrl}
                target="_blank"
                rel="noreferrer noopener"
                className={
                  accessUrlInvalidated
                    ? "line-through text-muted-foreground"
                    : "text-[#0B2545] underline hover:no-underline inline-flex items-center gap-1"
                }
                data-testid={`link-archisign-access-${devisId}`}
              >
                Ouvrir
                {!accessUrlInvalidated && <ExternalLink className="h-3 w-3" />}
              </a>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
            {accessUrlInvalidated && (
              <div
                className="mt-1 text-[11px] text-amber-700"
                data-testid={`text-archisign-expired-note-${devisId}`}
              >
                Lien expiré — la fonction de renvoi sera disponible dans une prochaine mise à jour.
              </div>
            )}
          </div>
          <div>
            <span className="font-semibold text-muted-foreground">Destination OTP :</span>{" "}
            <span data-testid={`text-archisign-otp-${devisId}`}>{otpDestination ?? "—"}</span>
          </div>
          <div>
            <span className="font-semibold text-muted-foreground">Expire le :</span>{" "}
            <span data-testid={`text-archisign-expires-${devisId}`}>
              {expiresAt ? expiresAt.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
            </span>
          </div>
          <div>
            <span className="font-semibold text-muted-foreground">Enveloppe :</span>{" "}
            <span
              className="font-mono text-[11px]"
              data-testid={`text-archisign-envelope-${devisId}`}
            >
              {d.archisignEnvelopeId ?? "—"}
            </span>
          </div>
          {/* Personalised note the architect attached on first send.
              Persisted on our side so it survives regardless of whether
              Archisign renders it in the signer email. */}
          {d.archisignSignerMessage && (
            <div className="sm:col-span-2">
              <span className="font-semibold text-muted-foreground">Message au signataire :</span>
              <p
                className="mt-1 whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 text-[11px] text-foreground"
                data-testid={`text-archisign-signer-message-${devisId}`}
              >
                {d.archisignSignerMessage}
              </p>
            </div>
          )}
          {/* Task #206 — once the signed PDF has been persisted locally,
              surface a direct view link alongside the envelope details
              so the architect can pull up the audit copy without
              digging through Drive. */}
          {d.signedPdfStorageKey && (
            <div className="sm:col-span-2">
              <span className="font-semibold text-muted-foreground">PDF signé :</span>{" "}
              <a
                href={`/api/devis/${devisId}/signed-pdf`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[#0B2545] underline hover:no-underline inline-flex items-center gap-1"
                data-testid={`link-signed-pdf-${devisId}`}
              >
                Ouvrir le PDF signé
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      )}
    </LuxuryCard>
  );
}
