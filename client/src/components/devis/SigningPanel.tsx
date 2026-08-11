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
import { Send, Loader2, ExternalLink, ArrowLeft, MailWarning, FileUp } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Devis, Project } from "@shared/schema";
import {
  DEVIS_CLIENT_MESSAGE_MIN_LEN,
  DEVIS_CLIENT_MESSAGE_MAX_LEN,
} from "@shared/schema";
import { buildClientSignatureMessageTemplate } from "@shared/signature-message-template";

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

  // Manual signed-copy pathway — secondary to Archisign. Dialog state for
  // "Record signed copy": the operator uploads the signed PDF, writes a
  // mandatory audit note, and can attach an external reference (e.g. an
  // Archisign envelope signed outside the ArchiDoc↔Archisign integration).
  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [manualFile, setManualFile] = useState<File | null>(null);
  const [manualNote, setManualNote] = useState("");
  const [manualExternalRef, setManualExternalRef] = useState("");

  const manualSignoffMutation = useMutation({
    mutationFn: async () => {
      if (!manualFile) throw new Error("Select the signed PDF first.");
      const form = new FormData();
      form.append("file", manualFile);
      form.append("note", manualNote.trim());
      if (manualExternalRef.trim()) form.append("externalReference", manualExternalRef.trim());
      const res = await fetch(`/api/devis/${devisId}/record-signed-copy`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message || `${res.status}: ${res.statusText}`);
      }
      return res.json() as Promise<{ ok: boolean; workAuthorisationSent: boolean }>;
    },
    onSuccess: () => {
      toast({
        title: "Signed copy recorded",
        description:
          "The devis is now marked as signed by the client (manual upload). " +
          "Note: the Archidoc work authorisation is NOT sent automatically for manually recorded signatures.",
      });
      setManualDialogOpen(false);
      setManualFile(null);
      setManualNote("");
      setManualExternalRef("");
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId] });
      queryClient.invalidateQueries({ queryKey: ["/api/devis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not record the signed copy",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const sendMutation = useMutation({
    mutationFn: async (message: string | undefined) => {
      const trimmed = (message ?? "").trim();
      const body = trimmed.length > 0 ? { message: trimmed } : {};
      const res = await apiRequest("POST", `/api/devis/${devisId}/send-to-signer`, body);
      return res.json() as Promise<{
        contextEmail?: { status?: "sent" | "failed" | "already_sent"; error?: string };
        subjectDrift?: boolean;
        bodyDrift?: boolean;
      }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Sent for signature",
        description: "The Archisign envelope has been created and sent to the signer.",
      });
      // Task #257 — the contextual email failure never rolls back the
      // envelope, but the architect MUST see that the client did not get
      // the written context.
      // Task #279 — Archisign confirmed the envelope but reported that our
      // custom email subject was DROPPED (fell back to their default). The
      // envelope still went out; the architect just needs to know the
      // client saw a generic subject line.
      if (data?.subjectDrift) {
        toast({
          title: "Custom email subject not applied",
          description:
            "Archisign sent the invitation under its default subject instead of the custom one. " +
            "The signing request itself went out normally. Recurring drift is tracked under Admin ops → Archisign rendering.",
          variant: "destructive",
        });
      }
      // Task #283 — the body half of the same echo: Archisign reported
      // that the architect's personal note was NOT rendered in the signer
      // invitation, despite the in-force contract requiring it. Our own
      // context email still delivers the note (redundancy), so this is a
      // warning, not a rollback.
      if (data?.bodyDrift) {
        toast({
          title: "Personal message not shown in the invitation",
          description:
            "Archisign reported that your message to the client was not included in its invitation email. " +
            "The client still receives your message via the separate context email. " +
            "Recurring drift is tracked under Admin ops → Archisign rendering.",
          variant: "destructive",
        });
      }
      if (data?.contextEmail?.status === "failed") {
        toast({
          title: "Context email NOT sent",
          description:
            "The Archisign envelope went out, but the accompanying email to the client failed. " +
            "Contact the client directly or retry from the project communications." +
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
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "context-email-status"] });
    },
    onError: (error: Error) => {
      // Distinguish a transient Archisign outage from everything else:
      // the operator should simply retry in a few minutes, nothing is
      // wrong with the app or its configuration.
      const code = (error as { data?: { code?: string } }).data?.code;
      if (code === "archisign_unavailable") {
        toast({
          title: "Archisign temporarily unavailable",
          description:
            "The signature service is momentarily down — nothing is wrong on your side. " +
            "Wait a few minutes and press “Send for signature” again.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Send failed", description: error.message, variant: "destructive" });
    },
  });

  // Task #258 — resend recovery for a failed context email. The status
  // query keys off the same dedupeKey the original dispatch used, so
  // `canResend` is true only when the CURRENT envelope has a persisted
  // architect message but no successfully-sent `devis_signature_context`
  // communication row.
  const contextEmailStatusQuery = useQuery<{
    canResend: boolean;
    emailStatus: string | null;
    reason: string | null;
  }>({
    queryKey: ["/api/devis", devisId, "context-email-status"],
    enabled: Boolean(devisQuery.data?.archisignEnvelopeId && devisQuery.data?.archisignSignerMessage),
  });

  const resendContextEmailMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/resend-context-email`, {});
      return res.json() as Promise<{
        contextEmail?: { status?: "sent" | "failed" | "already_sent" };
      }>;
    },
    onSuccess: (data) => {
      toast({
        title:
          data?.contextEmail?.status === "already_sent"
            ? "Context email already sent"
            : "Context email sent",
        description:
          data?.contextEmail?.status === "already_sent"
            ? "The client has already received the accompanying email for this envelope."
            : "The accompanying email has been sent to the client.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "context-email-status"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to resend the context email",
        description: error.message,
        variant: "destructive",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "context-email-status"] });
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
    archisignSubjectDriftAt?: string | null;
    archisignBodyDriftAt?: string | null;
    signedPdfStorageKey?: string | null;
    signedOffVia?: string | null;
    manualSignoffAt?: string | null;
    manualSignoffNote?: string | null;
    manualSignoffExternalRef?: string | null;
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
    return buildClientSignatureMessageTemplate({
      refLabel: d.devisNumber || d.devisCode,
      descriptionFr: d.descriptionFr,
      amountTtcLabel,
      projectName: project?.name,
      clientContactName: project?.clientContactName,
    });
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
  // Task #279 — Archisign's /create echo reported subjectApplied=false for
  // the CURRENT envelope: the signer invitation went out under Archisign's
  // default email subject, not our custom one. Non-blocking, but the
  // architect must know the client saw a generic subject line.
  const subjectDriftAt = d.archisignSubjectDriftAt
    ? new Date(d.archisignSubjectDriftAt)
    : null;
  // Task #283 — bodyApplied=false for the CURRENT envelope: the architect's
  // personal note was NOT rendered in the signer invitation despite the
  // in-force §3.5.1.1(b) RENDERED election. Non-blocking (the context email
  // still delivers the note), but the architect must know.
  const bodyDriftAt = d.archisignBodyDriftAt
    ? new Date(d.archisignBodyDriftAt)
    : null;

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
  //       struck-through alongside a "Link expired" note for audit context;
  //       AT4's brief excludes any *additional* resend-after-expiry
  //       orchestration (no new endpoints, no reminders), so the CTA
  //       reappearing IS the entire post-expiry surface.
  const canSend = stage === "approved_for_signing" && !isArchived;
  const isResume = canSend && !!d.archisignEnvelopeId;

  const statusLabel: Record<string, { label: string; tone: "default" | "secondary" | "destructive" }> = {
    sent: { label: "Sent", tone: "default" },
    viewed: { label: "Viewed", tone: "default" },
    queried: { label: "Question open", tone: "secondary" },
    signed: { label: "Signed", tone: "default" },
    declined: { label: "Declined", tone: "destructive" },
    expired: { label: "Expired", tone: "destructive" },
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
          <TechnicalLabel className="text-sm">Electronic signature</TechnicalLabel>
          {badge && (
            <Badge
              variant={badge.tone === "destructive" ? "destructive" : badge.tone === "secondary" ? "secondary" : "default"}
              data-testid={`badge-archisign-status-${devisId}`}
            >
              {badge.label}
            </Badge>
          )}
          {subjectDriftAt && (
            <Badge
              variant="outline"
              className="border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200 gap-1"
              data-testid={`badge-subject-drift-${devisId}`}
              title={`Reported by Archisign on ${subjectDriftAt.toLocaleString()}`}
            >
              <MailWarning className="h-3 w-3" />
              Default subject used
            </Badge>
          )}
          {stage === "client_signed_off" && d.signedOffVia === "manual_upload" && (
            <Badge
              variant="outline"
              className="border-blue-500 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-200 gap-1"
              data-testid={`badge-manual-signoff-${devisId}`}
              title={
                (d.manualSignoffAt ? `Recorded ${new Date(d.manualSignoffAt).toLocaleString()}` : "Manually recorded") +
                (d.manualSignoffNote ? ` — ${d.manualSignoffNote}` : "") +
                (d.manualSignoffExternalRef ? ` (ref: ${d.manualSignoffExternalRef})` : "")
              }
            >
              <FileUp className="h-3 w-3" />
              Signed — manual upload
            </Badge>
          )}
          {bodyDriftAt && (
            <Badge
              variant="outline"
              className="border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200 gap-1"
              data-testid={`badge-body-drift-${devisId}`}
              title={`Reported by Archisign on ${bodyDriftAt.toLocaleString()}`}
            >
              <MailWarning className="h-3 w-3" />
              Message not shown
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
        {(stage === "approved_for_signing" || stage === "sent_to_client") && !isArchived && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setManualDialogOpen(true)}
            disabled={manualSignoffMutation.isPending}
            data-testid={`button-record-signed-copy-${devisId}`}
          >
            <FileUp className="h-4 w-4 mr-1.5" />
            Record signed copy
          </Button>
        )}
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
                {isResume ? "Resuming…" : "Sending…"}
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-1.5" />
                {isResume ? "Retry send" : "Send for signature"}
              </>
            )}
          </Button>
        )}
        </div>
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
                ? "Retry sending for signature"
                : dialogStep === "compose"
                  ? "Step 1 of 2 — Message to the client"
                  : "Step 2 of 2 — Review before sending"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isResume
                ? "The envelope has already been created at Archisign — retrying only re-triggers delivery to the signer, then resends the accompanying email if needed. The message entered when the envelope was first created cannot be changed."
                : dialogStep === "compose"
                  ? "Write the accompanying message the client will receive by email (required). The signing link will be sent to them separately by Archisign."
                  : "Review what the client will receive. Sending will create the Archisign envelope and deliver this message to the client."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {!isResume && dialogStep === "compose" && (
            <div className="space-y-2">
              <label
                htmlFor={`textarea-send-message-${devisId}`}
                className="text-sm font-medium"
              >
                Message to the client (required)
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
                    : `Minimum ${DEVIS_CLIENT_MESSAGE_MIN_LEN} characters required`}
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
                  <span className="font-semibold text-muted-foreground">Recipient:</span>{" "}
                  <span data-testid={`text-recap-recipient-${devisId}`}>
                    {recipientName} ({recipientEmail})
                  </span>
                </div>
                <div>
                  <span className="font-semibold text-muted-foreground">Devis:</span>{" "}
                  <span data-testid={`text-recap-devis-${devisId}`}>{refLabel}</span>
                </div>
                <div>
                  <span className="font-semibold text-muted-foreground">Amount:</span>{" "}
                  <span data-testid={`text-recap-amount-${devisId}`}>
                    {amountTtcLabel ? `${amountTtcLabel} € TTC` : "—"}
                  </span>
                </div>
              </div>
              <div>
                <span className="text-xs font-semibold text-muted-foreground">Message to the client:</span>
                <p
                  className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 text-xs"
                  data-testid={`text-recap-message-${devisId}`}
                >
                  {personalMessage}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                The client will receive this email from your Gmail address, then a
                separate email from Archisign containing the secure signing link.
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
                Edit message
              </Button>
            )}
            <AlertDialogCancel
              disabled={sendMutation.isPending}
              data-testid={`button-send-to-signer-cancel-${devisId}`}
            >
              Cancel
            </AlertDialogCancel>
            {!isResume && dialogStep === "compose" ? (
              <Button
                onClick={() => setDialogStep("recap")}
                disabled={!composeValid || sendMutation.isPending}
                data-testid={`button-send-to-signer-continue-${devisId}`}
              >
                Continue
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
                    {isResume ? "Resuming…" : "Sending…"}
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-1.5" />
                    {isResume ? "Retry send" : "Confirm and send"}
                  </>
                )}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Manual signed-copy dialog — the secondary pathway. Upload the
          signed PDF + mandatory audit note + optional external reference
          (e.g. an Archisign envelope signed outside this integration). */}
      <AlertDialog
        open={manualDialogOpen}
        onOpenChange={(open) => {
          if (!open && !manualSignoffMutation.isPending) setManualDialogOpen(false);
        }}
      >
        <AlertDialogContent data-testid={`dialog-record-signed-copy-${devisId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Record an externally signed copy</AlertDialogTitle>
            <AlertDialogDescription>
              Use this when the devis was signed outside the standard Archisign flow — on paper,
              via another provider, or in Archisign but outside this integration. The devis will
              be marked as signed by the client with a "manual upload" provenance, distinct from a
              verified Archisign signature. The Archidoc work authorisation is not sent
              automatically for manually recorded signatures.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Signed PDF (required)</label>
              <Input
                type="file"
                accept="application/pdf,.pdf"
                className="mt-1"
                onChange={(e) => setManualFile(e.target.files?.[0] ?? null)}
                data-testid={`input-signed-copy-file-${devisId}`}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">
                Justification note (required, min 10 characters)
              </label>
              <Textarea
                value={manualNote}
                onChange={(e) => setManualNote(e.target.value)}
                placeholder="e.g. Client signed in Archisign directly (outside the ArchiDoc workflow); envelope ref below."
                className="mt-1 min-h-[70px] text-sm"
                data-testid={`input-signed-copy-note-${devisId}`}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">
                External reference (optional — e.g. Archisign envelope ID)
              </label>
              <Input
                value={manualExternalRef}
                onChange={(e) => setManualExternalRef(e.target.value)}
                placeholder="Envelope ID or other signing reference"
                className="mt-1"
                data-testid={`input-signed-copy-ref-${devisId}`}
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={manualSignoffMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                manualSignoffMutation.mutate();
              }}
              disabled={
                manualSignoffMutation.isPending || !manualFile || manualNote.trim().length < 10
              }
              data-testid={`button-record-signed-copy-confirm-${devisId}`}
            >
              {manualSignoffMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Recording…
                </>
              ) : (
                <>
                  <FileUp className="h-4 w-4 mr-1.5" />
                  Record as signed
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {!d.archisignEnvelopeId && !accessUrl && stage === "approved_for_signing" && (
        <p className="text-xs text-muted-foreground" data-testid={`text-signing-empty-${devisId}`}>
          No Archisign envelope created yet. The client will receive a signing link after sending.
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
            <span className="font-semibold text-muted-foreground">Client link:</span>{" "}
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
                Open
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
                Link expired — resend will be available in a future update.
              </div>
            )}
          </div>
          <div>
            <span className="font-semibold text-muted-foreground">OTP destination:</span>{" "}
            <span data-testid={`text-archisign-otp-${devisId}`}>{otpDestination ?? "—"}</span>
          </div>
          <div>
            <span className="font-semibold text-muted-foreground">Expires:</span>{" "}
            <span data-testid={`text-archisign-expires-${devisId}`}>
              {expiresAt ? expiresAt.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
            </span>
          </div>
          <div>
            <span className="font-semibold text-muted-foreground">Envelope:</span>{" "}
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
              <span className="font-semibold text-muted-foreground">Message to the signer:</span>
              <p
                className="mt-1 whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 text-[11px] text-foreground"
                data-testid={`text-archisign-signer-message-${devisId}`}
              >
                {d.archisignSignerMessage}
              </p>
              {/* Task #258 — one-click recovery when the contextual client
                  email failed on the original send. Visible only when the
                  status endpoint confirms no successful communication row
                  exists for the CURRENT envelope. */}
              {contextEmailStatusQuery.data?.canResend && (
                <div className="mt-2 flex items-center gap-2">
                  <MailWarning className="h-3.5 w-3.5 text-destructive shrink-0" />
                  <span
                    className="text-[11px] text-destructive"
                    data-testid={`text-context-email-missing-${devisId}`}
                  >
                    The accompanying email was not sent to the client.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => resendContextEmailMutation.mutate()}
                    disabled={resendContextEmailMutation.isPending}
                    data-testid={`button-resend-context-email-${devisId}`}
                  >
                    {resendContextEmailMutation.isPending ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        Sending…
                      </>
                    ) : (
                      "Resend context email"
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
          {/* Task #206 — once the signed PDF has been persisted locally,
              surface a direct view link alongside the envelope details
              so the architect can pull up the audit copy without
              digging through Drive. */}
          {d.signedPdfStorageKey && (
            <div className="sm:col-span-2">
              <span className="font-semibold text-muted-foreground">Signed PDF:</span>{" "}
              <a
                href={`/api/devis/${devisId}/signed-pdf`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[#0B2545] underline hover:no-underline inline-flex items-center gap-1"
                data-testid={`link-signed-pdf-${devisId}`}
              >
                Open the signed PDF
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      )}
    </LuxuryCard>
  );
}
