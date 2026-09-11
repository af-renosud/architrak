import { useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Send } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, projectScopedKey } from "@/lib/queryClient";

type ContractorCopyDelivery = {
  id: number;
  status: string;
  recipientEmail: string | null;
  sentAt: string | null;
  lastError: string | null;
  communicationId: number | null;
  canRetry: boolean;
  source: string;
};

type ContractorCopyResponse = {
  canSend: boolean;
  reason: string | null;
  contractorName: string | null;
  recipientEmail: string | null;
  quotationRef: string;
  confirmationToken: string | null;
  deliveries: ContractorCopyDelivery[];
};

function createContractorCopyRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Older browsers and some test jsdom versions do not expose randomUUID.
  // Keep the fallback RFC 4122-shaped so the request remains a valid idempotency key.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function contractorCopyStatusLabel(status: string): string {
  const normalized = status.toLowerCase().replace(/[\s-]+/g, "_");
  const labels: Record<string, string> = {
    pending_pdf: "Waiting for signed PDF",
    queued: "Queued",
    sending: "Sending",
    reconciling: "Send result unconfirmed",
    sent: "Accepted by email provider",
    failed: "Failed",
    blocked: "Blocked",
  };
  return labels[normalized] ?? status;
}

function contractorCopyStatusClass(status: string): string {
  const normalized = status.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "sent") return "text-emerald-700 dark:text-emerald-300";
  if (normalized === "failed" || normalized === "blocked") return "text-destructive";
  if (normalized === "reconciling") return "text-violet-700 dark:text-violet-300";
  return "text-muted-foreground";
}

function isContractorCopyPending(status: string): boolean {
  return new Set(["pending_pdf", "queued", "sending", "reconciling", "pending", "processing"]).has(
    status.toLowerCase().replace(/[\s-]+/g, "_"),
  );
}

export function ContractorCopySend({
  devisId,
  projectId,
  isArchived,
  isSigned,
}: {
  devisId: number;
  projectId: number;
  isArchived: boolean;
  isSigned: boolean;
}) {
  const { toast } = useToast();
  const contractorCopyQuery = useQuery<ContractorCopyResponse>({
    queryKey: ["/api/devis", devisId, "contractor-copy"],
    refetchOnMount: "always",
    enabled: !isArchived,
    refetchInterval: (query) => {
      const deliveries = query.state.data?.deliveries ?? [];
      return deliveries.some((delivery) => isContractorCopyPending(delivery.status))
        ? 3000
        : false;
    },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogData, setDialogData] = useState<ContractorCopyResponse | null>(null);
  const [dialogRequestId, setDialogRequestId] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogRefreshing, setDialogRefreshing] = useState(false);
  const [staleToken, setStaleToken] = useState(false);
  const [needsReconfirmation, setNeedsReconfirmation] = useState(false);
  const [retryingNoticeId, setRetryingNoticeId] = useState<number | null>(null);

  const contractorCopyQueryKey = ["/api/devis", devisId, "contractor-copy"];
  const invalidateContractorCopyData = () => {
    queryClient.invalidateQueries({ queryKey: contractorCopyQueryKey });
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "signed-copy-notice"] });
    queryClient.invalidateQueries({ queryKey: ["/api/communications"] });
    queryClient.invalidateQueries({ queryKey: projectScopedKey(projectId, "communications") });
  };

  const refreshDialogData = async (reconfirmation = false) => {
    setDialogRefreshing(true);
    setDialogError(null);
    const result = await contractorCopyQuery.refetch();
    if (result.error) {
      setDialogError(result.error instanceof Error ? result.error.message : "Could not refresh contractor copy details.");
    } else if (result.data) {
      setDialogData(result.data);
      if (reconfirmation) {
        setNeedsReconfirmation(true);
        setStaleToken(false);
      }
    }
    setDialogRefreshing(false);
  };

  const openDialog = () => {
    // One request id belongs to this deliberate confirmation intent. It is
    // retained if POST fails, and is replaced only by a newly opened dialog
    // after a successful request.
    setDialogRequestId(createContractorCopyRequestId());
    setDialogData(null);
    setDialogError(null);
    setStaleToken(false);
    setNeedsReconfirmation(false);
    setDialogOpen(true);
    void refreshDialogData();
  };

  function closeDialog(force = false) {
    if (!force && sendMutation.isPending) return;
    setDialogOpen(false);
    setDialogData(null);
    setDialogRequestId(null);
    setDialogError(null);
    setStaleToken(false);
    setNeedsReconfirmation(false);
  }

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!dialogRequestId) throw new Error("Confirmation expired. Open the dialog again.");
      if (!dialogData?.confirmationToken) {
        throw new Error("A fresh contractor-copy confirmation is required.");
      }
      const res = await apiRequest("POST", `/api/devis/${devisId}/contractor-copy`, {
        requestId: dialogRequestId,
        confirmationToken: dialogData.confirmationToken,
      });
      return res.json() as Promise<ContractorCopyResponse>;
    },
    onSuccess: (data) => {
      setDialogData(data);
      queryClient.setQueryData(contractorCopyQueryKey, data);
      invalidateContractorCopyData();
      closeDialog(true);
      const deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
      const latestDelivery = [...deliveries].sort((left, right) => right.id - left.id)[0];
      const latestStatus = latestDelivery?.status.toLowerCase().replace(/[\s-]+/g, "_");
      const acceptedByProvider = latestStatus === "sent";
      const stillPending = latestStatus ? isContractorCopyPending(latestStatus) : false;
      const failed = latestStatus === "failed" || latestStatus === "blocked";
      const unresolved = latestStatus === "reconciling";
      toast({
        title: acceptedByProvider
          ? "Contractor copy accepted by email provider"
          : stillPending
            ? "Contractor copy queued"
            : failed
              ? "Contractor copy failed"
              : unresolved
                ? "Contractor copy send result unconfirmed"
                : "Contractor copy status updated",
        variant: failed || unresolved ? "destructive" : undefined,
        description: acceptedByProvider
          ? "The signed quotation was accepted by the email provider; this does not confirm inbox delivery."
          : stillPending
            ? "The signed quotation is waiting to be processed by the email provider."
            : latestDelivery?.lastError || "The delivery history has been updated.",
      });
    },
    onError: (error: Error) => {
      const apiError = error as Error & { status?: number; data?: unknown };
      const errorData =
        apiError.data && typeof apiError.data === "object"
          ? (apiError.data as { code?: unknown; message?: unknown })
          : null;
      const isStale =
        apiError.status === 409 ||
        apiError.status === 412 ||
        errorData?.code === "stale_confirmation_token" ||
        errorData?.code === "contractor_copy_confirmation_stale" ||
        errorData?.code === "confirmation_token_stale";
      if (isStale) {
        setStaleToken(true);
        setNeedsReconfirmation(false);
        setDialogError(
          typeof errorData?.message === "string"
            ? errorData.message
            : "The delivery confirmation is no longer current; refresh the details before trying again.",
        );
        toast({
          title: "Confirmation needs refreshing",
          description: "Refresh the contractor-copy details, review them again, then confirm deliberately.",
          variant: "destructive",
        });
      } else {
        setDialogError(error.message);
        toast({
          title: "Could not send the contractor copy",
          description: error.message,
          variant: "destructive",
        });
      }
      // Deliberately do not clear dialogRequestId: a failed or uncertain
      // request must be retried with the same idempotency identity.
      invalidateContractorCopyData();
    },
  });

  const retryDeliveryMutation = useMutation({
    mutationFn: async (noticeId: number) => {
      const res = await apiRequest(
        "POST",
        `/api/devis/${devisId}/contractor-copy/${noticeId}/retry`,
        {},
      );
      return res.json() as Promise<ContractorCopyResponse>;
    },
    onMutate: (noticeId) => setRetryingNoticeId(noticeId),
    onSuccess: (data) => {
      queryClient.setQueryData(contractorCopyQueryKey, data);
      invalidateContractorCopyData();
      toast({
        title: "Contractor-copy status refreshed",
        description:
          "The existing delivery was checked without starting a blind resend.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not retry the contractor copy",
        description: error.message,
        variant: "destructive",
      });
      invalidateContractorCopyData();
    },
    onSettled: () => setRetryingNoticeId(null),
  });

  const response = contractorCopyQuery.data;
  const canSend =
    !isArchived &&
    isSigned &&
    !contractorCopyQuery.error &&
    Boolean(response?.canSend) &&
    Boolean(response?.confirmationToken);
  const unavailableReason = isArchived
    ? "Archived projects cannot send a contractor copy."
    : !isSigned
      ? "The quotation must have a verified completed Archisign signature and stored signed PDF."
    : contractorCopyQuery.isLoading
      ? "Checking signed-document and recipient eligibility…"
      : contractorCopyQuery.error
        ? `Could not check contractor-copy eligibility: ${
            contractorCopyQuery.error instanceof Error
              ? contractorCopyQuery.error.message
              : "request failed"
          }`
        : response?.reason ||
          "The verified signed PDF, contractor, or recipient is not currently available.";
  const deliveries = response?.deliveries ?? [];
  const dialogDeliveries = (dialogData ?? response)?.deliveries ?? [];
  const previousAcceptedDelivery = dialogDeliveries.some(
    (delivery) => delivery.status.toLowerCase().replace(/[\s-]+/g, "_") === "sent",
  );
  const dialogCanSend =
    !dialogRefreshing &&
    !staleToken &&
    Boolean(dialogData?.canSend && dialogData.confirmationToken && dialogRequestId);

  return (
    <div
      className="border-t border-border pt-3"
      data-testid={`contractor-copy-send-${devisId}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Contractor copy</p>
          <p className="text-xs text-muted-foreground">
            Send the verified Archisign-signed quotation without changing signature settings.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={openDialog}
          disabled={!canSend || contractorCopyQuery.isLoading || sendMutation.isPending}
          title={!canSend ? unavailableReason : undefined}
          aria-describedby={!canSend ? `text-contractor-copy-unavailable-${devisId}` : undefined}
          data-testid={`button-send-to-contractor-${devisId}`}
        >
          {sendMutation.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <Send className="mr-1.5 h-4 w-4" />
              Send to Contractor
            </>
          )}
        </Button>
      </div>
      {!canSend && (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid={`text-contractor-copy-unavailable-${devisId}`}
        >
          {unavailableReason}
        </p>
      )}

      {deliveries.length > 0 && (
        <div className="mt-3 space-y-2" data-testid={`contractor-copy-history-${devisId}`}>
          <p className="text-xs font-semibold text-muted-foreground">Delivery history</p>
          {deliveries.map((delivery) => {
            const normalizedStatus = delivery.status.toLowerCase().replace(/[\s-]+/g, "_");
            const isRetrying = retryingNoticeId === delivery.id;
            const sentDate = delivery.sentAt
              ? new Date(delivery.sentAt).toLocaleString("fr-FR", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : null;
            return (
              <div
                key={delivery.id}
                className="flex items-start justify-between gap-3 rounded border border-border bg-muted/20 px-2.5 py-2 text-xs"
                data-testid={`contractor-copy-delivery-${delivery.id}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium">
                      {delivery.source.toLowerCase() === "manual" ? "Manual" : "Automatic"}
                    </span>
                    <span className={contractorCopyStatusClass(delivery.status)}>
                      {contractorCopyStatusLabel(delivery.status)}
                    </span>
                    {sentDate && <span className="text-muted-foreground">{sentDate}</span>}
                  </div>
                  {delivery.recipientEmail && (
                    <p className="text-muted-foreground">{delivery.recipientEmail}</p>
                  )}
                  {normalizedStatus === "sent" && (
                    <p className="mt-0.5 text-muted-foreground">
                      Accepted by the email provider; this does not confirm inbox delivery.
                    </p>
                  )}
                  {normalizedStatus !== "sent" && delivery.lastError && (
                    <p className="mt-0.5 break-words text-destructive">{delivery.lastError}</p>
                  )}
                </div>
                {delivery.canRetry && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2 text-[10px]"
                    disabled={retryDeliveryMutation.isPending}
                    onClick={() => retryDeliveryMutation.mutate(delivery.id)}
                    data-testid={`button-retry-contractor-copy-${delivery.id}`}
                  >
                    {isRetrying ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3 w-3" />
                    )}
                    {normalizedStatus === "reconciling" ? "Check send result" : "Retry"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <AlertDialogContent data-testid={`dialog-send-to-contractor-${devisId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Send to Contractor</AlertDialogTitle>
            <AlertDialogDescription>
              Confirm the recipient and signed quotation before sending another contractor copy.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {dialogRefreshing && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`text-contractor-copy-refreshing-${devisId}`}>
              <Loader2 className="h-4 w-4 animate-spin" />
              Refreshing contractor and quotation details…
            </div>
          )}

          {!dialogRefreshing && dialogData && (
            <div className="space-y-3 text-sm" data-testid={`recap-send-to-contractor-${devisId}`}>
              <div className="grid grid-cols-1 gap-2 rounded border border-border bg-muted/20 p-3 text-xs sm:grid-cols-2">
                <div>
                  <span className="font-semibold text-muted-foreground">Contractor:</span>{" "}
                  <span data-testid={`text-contractor-copy-name-${devisId}`}>
                    {dialogData.contractorName || "—"}
                  </span>
                </div>
                <div>
                  <span className="font-semibold text-muted-foreground">Email:</span>{" "}
                  <span data-testid={`text-contractor-copy-email-${devisId}`}>
                    {dialogData.recipientEmail || "—"}
                  </span>
                </div>
                <div className="sm:col-span-2">
                  <span className="font-semibold text-muted-foreground">Signed quotation:</span>{" "}
                  <span data-testid={`text-contractor-copy-quotation-${devisId}`}>
                    {dialogData.quotationRef || "—"}
                  </span>
                </div>
              </div>

              {previousAcceptedDelivery && (
                <div
                  className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                  data-testid={`warning-contractor-copy-previously-sent-${devisId}`}
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    A previous copy was accepted by the email provider. Confirming sends another
                    copy; it does not confirm inbox delivery.
                  </span>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                The verified signed PDF for quotation {dialogData.quotationRef || "—"} will be
                attached. This does not restart signature collection, authorise work, or request
                payment.
              </p>

              {dialogData.reason && !dialogData.canSend && (
                <p className="text-xs text-destructive" data-testid={`text-contractor-copy-dialog-reason-${devisId}`}>
                  {dialogData.reason}
                </p>
              )}
            </div>
          )}

          {dialogError && (
            <div
              className="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              role="alert"
              data-testid={`error-send-to-contractor-${devisId}`}
            >
              {dialogError}
            </div>
          )}

          {staleToken && (
            <div
              className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
              data-testid={`warning-contractor-copy-stale-${devisId}`}
            >
              The displayed confirmation is stale. Refresh and review the contractor, email, and
              quotation again before confirming; no new send has been started.
            </div>
          )}

          {needsReconfirmation && !staleToken && (
            <p
              className="text-xs text-amber-700 dark:text-amber-300"
              data-testid={`text-contractor-copy-reconfirm-${devisId}`}
            >
              Details refreshed. Review them again and confirm deliberately.
            </p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={sendMutation.isPending}
              data-testid={`button-send-to-contractor-cancel-${devisId}`}
            >
              Cancel
            </AlertDialogCancel>
            {staleToken ? (
              <Button
                type="button"
                onClick={() => void refreshDialogData(true)}
                disabled={dialogRefreshing || sendMutation.isPending}
                data-testid={`button-refresh-contractor-copy-${devisId}`}
              >
                {dialogRefreshing ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                )}
                Refresh and review
              </Button>
            ) : (
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  sendMutation.mutate();
                }}
                disabled={!dialogCanSend || sendMutation.isPending}
                data-testid={`button-send-to-contractor-confirm-${devisId}`}
              >
                {sendMutation.isPending ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>
                    <Send className="mr-1.5 h-4 w-4" />
                    Confirm and send
                  </>
                )}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}