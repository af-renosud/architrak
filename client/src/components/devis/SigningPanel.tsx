import { useEffect, useMemo, useState } from "react";
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
import { Send, Loader2, ExternalLink, ArrowLeft } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Devis, Project } from "@shared/schema";
import {
  DEVIS_CLIENT_MESSAGE_MIN_LEN,
  DEVIS_CLIENT_MESSAGE_MAX_LEN,
} from "@shared/schema";

/**
 * Task #257 — the workflow stepper's "Sent to Client" button no longer
 * PATCHes the stage; it dispatches this event so the SigningPanel scrolls
 * into view and opens the (mandatory-context) send dialog.
 */
export const OPEN_SIGNING_SEND_EVENT = "architrak:open-signing-send";

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

  // Task #257 — the client-context message is MANDATORY on first send.
  // Two-step dialog: (1) compose the message (pre-filled editable
  // template), (2) recap of what the client will receive + final confirm.
  // The resume branch (envelopeId already persisted) keeps its single
  // confirm step and reuses the message persisted on the devis.
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [personalMessage, setPersonalMessage] = useState("");
  const [dialogStep, setDialogStep] = useState<"compose" | "recap">("compose");
  const [openRequested, setOpenRequested] = useState(false);

  const sendMutation = useMutation({
    mutationFn: async (message: string | undefined) => {
      const trimmed = (message ?? "").trim();
      const body = trimmed.length > 0 ? { message: trimmed } : {};
      const res = await apiRequest("POST", `/api/devis/${devisId}/send-to-signer`, body);
      return res.json() as Promise<{
        contextEmail?: { status?: "sent" | "failed" | "already_sent"; error?: string };
      }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Envoyé à la signature",
        description: "L'enveloppe Archisign a été créée et envoyée au signataire.",
      });
      // Task #257 — the contextual email failure never rolls back the
      // envelope, but the architect MUST see that the client did not get
      // the written context.
      if (data?.contextEmail?.status === "failed") {
        toast({
          title: "E-mail de contexte NON envoyé",
          description:
            "L'enveloppe Archisign est partie, mais l'e-mail d'accompagnement au client a échoué. " +
            "Contactez le client directement ou réessayez depuis les communications du projet." +
            (data.contextEmail.error ? ` (${data.contextEmail.error})` : ""),
          variant: "destructive",
        });
      }
      setSendDialogOpen(false);
      setPersonalMessage("");
      setDialogStep("compose");
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

  // Project data feeds the pre-filled message template and the recap step
  // (recipient name/email). Loaded lazily once the devis row is available.
  const projectQuery = useQuery<Project>({
    queryKey: ["/api/projects", d?.projectId],
    enabled: Boolean(d?.projectId),
  });
  const project = projectQuery.data;

  const amountTtcLabel = useMemo(() => {
    const n = Number(d?.amountTtc);
    if (!Number.isFinite(n)) return null;
    return new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  }, [d?.amountTtc]);

  // Pre-filled editable template with project/devis references. The
  // architect can rewrite it entirely — only the min length is enforced.
  const messageTemplate = useMemo(() => {
    if (!d) return "";
    const refLabel = d.devisNumber || d.devisCode;
    const clientName = (project?.clientContactName ?? "").trim();
    const greeting = clientName ? `Bonjour ${clientName},` : "Bonjour,";
    const amountPart = amountTtcLabel ? ` d'un montant de ${amountTtcLabel} € TTC` : "";
    const projectPart = project?.name ? ` pour le projet « ${project.name} »` : "";
    return (
      `${greeting}\n\n` +
      `Le devis ${refLabel} (${d.descriptionFr})${amountPart}${projectPart} est prêt pour signature électronique.\n\n` +
      `Vous recevrez dans quelques instants un e-mail d'Archisign contenant le lien de signature sécurisé. ` +
      `N'hésitez pas à me contacter pour toute question.\n\n` +
      `Cordialement,`
    );
  }, [d, project, amountTtcLabel]);

  // Task #257 — the workflow stepper dispatches OPEN_SIGNING_SEND_EVENT
  // instead of PATCHing sent_to_client. Scroll the panel into view and,
  // when the devis is actually sendable, open the compose dialog.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ devisId?: number }>).detail;
      if (detail?.devisId === devisId) setOpenRequested(true);
    };
    window.addEventListener(OPEN_SIGNING_SEND_EVENT, handler);
    return () => window.removeEventListener(OPEN_SIGNING_SEND_EVENT, handler);
  }, [devisId]);

  useEffect(() => {
    if (!openRequested || !d) return;
    setOpenRequested(false);
    document
      .querySelector(`[data-testid="panel-signing-${devisId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (d.signOffStage === "approved_for_signing" && !isArchived) {
      setPersonalMessage(messageTemplate);
      setDialogStep("compose");
      setSendDialogOpen(true);
    }
  }, [openRequested, d, isArchived, devisId, messageTemplate]);

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

  const trimmedLen = personalMessage.trim().length;
  const composeValid = trimmedLen >= DEVIS_CLIENT_MESSAGE_MIN_LEN;
  const recipientName = (project?.clientContactName ?? "").trim() || project?.clientName || "—";
  const recipientEmail = (project?.clientContactEmail ?? "").trim() || "—";
  const refLabel = d.devisNumber || d.devisCode;

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
              setPersonalMessage(messageTemplate);
              setDialogStep("compose");
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
              {isResume
                ? "Réessayer l'envoi à la signature"
                : dialogStep === "compose"
                  ? "Étape 1 / 2 — Message au client"
                  : "Étape 2 / 2 — Vérification avant envoi"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isResume
                ? "L'enveloppe a déjà été créée chez Archisign — un nouvel essai relance uniquement l'envoi au signataire, puis renvoie l'e-mail d'accompagnement si nécessaire. Le message saisi lors de la création initiale ne peut pas être modifié."
                : dialogStep === "compose"
                  ? "Rédigez le message d'accompagnement que le client recevra par e-mail (obligatoire). Le lien de signature lui sera envoyé séparément par Archisign."
                  : "Vérifiez ce que le client va recevoir. L'envoi créera l'enveloppe Archisign et transmettra ce message au client."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {!isResume && dialogStep === "compose" && (
            <div className="space-y-2">
              <label
                htmlFor={`textarea-send-message-${devisId}`}
                className="text-sm font-medium"
              >
                Message au client (obligatoire)
              </label>
              <Textarea
                id={`textarea-send-message-${devisId}`}
                value={personalMessage}
                onChange={(e) => setPersonalMessage(e.target.value.slice(0, DEVIS_CLIENT_MESSAGE_MAX_LEN))}
                rows={8}
                maxLength={DEVIS_CLIENT_MESSAGE_MAX_LEN}
                disabled={sendMutation.isPending}
                data-testid={`textarea-send-message-${devisId}`}
              />
              <div className="flex items-center justify-between text-xs">
                <span
                  className={composeValid ? "text-muted-foreground" : "text-destructive"}
                  data-testid={`text-send-message-min-${devisId}`}
                >
                  {composeValid
                    ? "\u00a0"
                    : `Minimum ${DEVIS_CLIENT_MESSAGE_MIN_LEN} caractères requis`}
                </span>
                <span
                  className="text-muted-foreground"
                  data-testid={`text-send-message-count-${devisId}`}
                >
                  {personalMessage.length} / {DEVIS_CLIENT_MESSAGE_MAX_LEN}
                </span>
              </div>
            </div>
          )}

          {!isResume && dialogStep === "recap" && (
            <div className="space-y-3 text-sm" data-testid={`recap-send-to-signer-${devisId}`}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="font-semibold text-muted-foreground">Destinataire :</span>{" "}
                  <span data-testid={`text-recap-recipient-${devisId}`}>
                    {recipientName} ({recipientEmail})
                  </span>
                </div>
                <div>
                  <span className="font-semibold text-muted-foreground">Devis :</span>{" "}
                  <span data-testid={`text-recap-devis-${devisId}`}>{refLabel}</span>
                </div>
                <div>
                  <span className="font-semibold text-muted-foreground">Montant :</span>{" "}
                  <span data-testid={`text-recap-amount-${devisId}`}>
                    {amountTtcLabel ? `${amountTtcLabel} € TTC` : "—"}
                  </span>
                </div>
              </div>
              <div>
                <span className="text-xs font-semibold text-muted-foreground">Message au client :</span>
                <p
                  className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 text-xs"
                  data-testid={`text-recap-message-${devisId}`}
                >
                  {personalMessage}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Le client recevra cet e-mail depuis votre adresse Gmail, puis un e-mail
                séparé d'Archisign contenant le lien de signature sécurisé.
              </p>
            </div>
          )}

          <AlertDialogFooter>
            {!isResume && dialogStep === "recap" && (
              <Button
                variant="outline"
                onClick={() => setDialogStep("compose")}
                disabled={sendMutation.isPending}
                data-testid={`button-send-to-signer-back-${devisId}`}
              >
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Modifier le message
              </Button>
            )}
            <AlertDialogCancel
              disabled={sendMutation.isPending}
              data-testid={`button-send-to-signer-cancel-${devisId}`}
            >
              Annuler
            </AlertDialogCancel>
            {!isResume && dialogStep === "compose" ? (
              <Button
                onClick={() => setDialogStep("recap")}
                disabled={!composeValid || sendMutation.isPending}
                data-testid={`button-send-to-signer-continue-${devisId}`}
              >
                Continuer
              </Button>
            ) : (
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
                    {isResume ? "Réessayer l'envoi" : "Confirmer et envoyer"}
                  </>
                )}
              </AlertDialogAction>
            )}
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
