import { useState } from "react";
import { ArchitectInvoiceBadge } from "@/components/certificats/ArchitectInvoiceSection";
import { useInvoiceAwareCertificatSend } from "@/hooks/use-invoice-aware-certificat-send";
import { Amount } from "@/components/ui/amount";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertCircle } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  Receipt,
  Award,
  Mail,
  PenLine,
  Check,
  HelpCircle,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import BurnUpChart from "@/components/dashboard/BurnUpChart";
import { Briefcase, ReceiptEuro } from "lucide-react";
import { OutstandingFeesPanel } from "@/components/fees/OutstandingFeesPanel";
import { DashboardDisclosure, DashboardQueryState } from "@/components/dashboard/DashboardDisclosure";
import type { OutstandingFeeSummary } from "@shared/fee-description";

interface DesignContractDashboardAction {
  milestoneId: number;
  contractId: number;
  projectId: number;
  projectName: string;
  projectCode: string;
  labelFr: string;
  amountTtc: string;
  reachedAt: string | null;
  triggerEvent: string;
}

/** Task #617 — dashboard alert: Gmail-detected fee invoices awaiting review. */
function DetectedFeeInvoicesAlert() {
  const { data, isLoading, error, refetch } = useQuery<{ id: number }[]>({
    queryKey: ["/api/architect-fee-invoices", { status: "pending_review" }],
    queryFn: async () => {
      const res = await fetch(`/api/architect-fee-invoices?status=pending_review`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });
  return (
    <DashboardDisclosure title="Detected fee invoices to verify" count={data?.length}
      summary="Detected documents · matching and project assignment not verified"
      issue={isLoading || error ? <DashboardQueryState loading={isLoading} error={error} retry={refetch} /> : undefined}>
    {data?.length === 0 && <p className="text-xs text-muted-foreground">No detected fee invoices awaiting verification.</p>}
    {!!data?.length && (
    <Link href="/honoraires/factures-detectees">
      <div
        className="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 cursor-pointer hover-elevate"
        data-testid="alert-pending-fee-invoices"
      >
        <ReceiptEuro size={14} className="text-amber-600 shrink-0" />
        <p className="text-xs text-amber-900 dark:text-amber-200">
          {data.length === 1
            ? "1 facture d'honoraires détectée attend votre vérification."
            : `${data.length} factures d'honoraires détectées attendent votre vérification.`}
        </p>
      </div>
    </Link>
    )}
    </DashboardDisclosure>
  );
}

function DesignFeeActionsStrip() {
  const { data, isLoading, error, refetch } = useQuery<DesignContractDashboardAction[]>({
    queryKey: ["/api/design-contracts/dashboard-actions"],
  });
  return (
    <DashboardDisclosure title="Design milestones awaiting invoice" count={data?.length}
      summary={<>{data && <><Amount value={data.reduce((sum, action) => sum + Number(action.amountTtc), 0)} denomination="TTC" /> · </>}Reached milestones · invoice to prepare</>}
      issue={isLoading || error ? <DashboardQueryState loading={isLoading} error={error} retry={refetch} /> : undefined}>
    <div data-testid="strip-design-fee-actions">
      {data?.length === 0 && <p className="text-xs text-muted-foreground">No reached milestones awaiting invoice.</p>}
      <div className="space-y-2 mt-3">
        {data?.map((a) => (
          <Link key={a.milestoneId} href={`/projets/${a.projectId}`}>
            <LuxuryCard className="cursor-pointer hover-elevate transition-all !rounded-lg !p-3" data-testid={`card-design-action-${a.milestoneId}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                    <Briefcase size={14} className="text-amber-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-foreground truncate">{a.labelFr}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{a.projectCode} · {a.projectName}</p>
                  </div>
                </div>
                <span className="text-[11px] font-semibold text-foreground whitespace-nowrap shrink-0">
                  <Amount value={parseFloat(a.amountTtc)} denomination="TTC" />
                </span>
              </div>
            </LuxuryCard>
          </Link>
        ))}
      </div>
    </div>
    </DashboardDisclosure>
  );
}

function GmailStatusBar({
  isLoading,
  data,
}: {
  isLoading: boolean;
  data: DashboardData | undefined;
}) {
  const { toast } = useToast();
  const pollMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/gmail/poll");
      return res.json() as Promise<{ processed: number; errors: number }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Inbox checked",
        description: `${result.processed} new document${result.processed === 1 ? "" : "s"} processed${result.errors > 0 ? `, ${result.errors} error${result.errors === 1 ? "" : "s"}` : ""}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/email-documents"] });
      // A successful manual scan persists a fresh poll timestamp — refetch
      // the poll-health classification and the per-user fallback timestamp
      // so a stale/auth warning clears immediately instead of staying cached.
      queryClient.invalidateQueries({ queryKey: ["/api/gmail/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Poll failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // After the Path 1 (per-user OAuth) refactor, "linkedUserCount" tells us
  // whether anyone has actually granted gmail.readonly via /api/auth/link-gmail.
  // The current user's own link state lives on /api/auth/user (gmailLinked).
  const { data: me, isLoading: meLoading, error: meError, refetch: refetchMe } = useQuery<{
    id: number;
    email: string;
    gmailLinked?: boolean;
    gmailLastPollAt?: string | null;
  }>({
    queryKey: ["/api/auth/user"],
  });
  // Persisted poll-health from the server (classified from
  // users.gmail_last_poll_* — survives restarts, unlike the monitor's
  // in-memory status which resets to "Never" and hid a dead poller for
  // two months in production).
  const { data: gmailStatus, isLoading: statusLoading, error: statusError, refetch: refetchStatus } = useQuery<{
    pollHealth?: { level: string; ageMs: number | null; message: string | null };
    needsAttentionCount?: number;
    needsProjectCount?: number;
    persistentFailureCount?: number;
  }>({
    queryKey: ["/api/gmail/status"],
  });
  const pollHealth = gmailStatus?.pollHealth;
  const needsAttentionCount = gmailStatus?.needsAttentionCount ?? gmailStatus?.needsProjectCount ?? 0;
  // Task #506 — messages stuck failing on every poll pass.
  const persistentFailureCount = gmailStatus?.persistentFailureCount ?? 0;
  const [showStuckDialog, setShowStuckDialog] = useState(false);
  const isStaleScan = pollHealth?.level === "stale" || pollHealth?.level === "never";
  const status = data?.gmailLastPollStatus ?? "idle";
  const isPermsError = status === "insufficient_permissions"; // legacy — superseded by no_linked_users
  const isNoLinkedUsers = status === "no_linked_users";
  const isAuthRevoked = status === "auth_revoked";
  const isOtherError = status === "error";
  const notConfigured = data && !data.gmailConfigured;
  const pollingDisabled = data && data.gmailConfigured && !data.gmailPolling;
  const meLinked = me?.gmailLinked === true;
  const showLinkCta = !notConfigured && (isNoLinkedUsers || isPermsError || isAuthRevoked || pollHealth?.level === "not_linked" || (!meLinked && me !== undefined));
  const isHealthAuthRevoked = pollHealth?.level === "auth_revoked";
  const isHealthOtherIssue = pollHealth?.level === "error" || pollHealth?.level === "not_linked";
  const hasIssue =
    notConfigured || isPermsError || isNoLinkedUsers || isAuthRevoked || isOtherError ||
    pollingDisabled || (!meLinked && me !== undefined) || isStaleScan || isHealthAuthRevoked || persistentFailureCount > 0 ||
    isHealthOtherIssue || !!meError || !!statusError || needsAttentionCount > 0 || !!pollMutation.error || (!isLoading && !data);

  const tone = hasIssue
    ? "border-amber-300 bg-amber-50/70 dark:border-amber-700 dark:bg-amber-950/30"
    : "border-border bg-muted/50";

  return (
    <div
      className={`flex flex-wrap items-center gap-2 px-4 py-3 rounded-lg border ${tone}`}
      data-testid="bar-gmail-status"
      role="region"
      aria-label="Gmail intake status and issues"
    >
      <div className="w-full text-[12px] font-semibold">
        {isLoading || meLoading || statusLoading ? "Checking Gmail monitoring status…" : hasIssue ? "Gmail monitoring needs attention" : "Gmail monitoring"}
      </div>
      <DashboardQueryState error={meError} retry={refetchMe} />
      <DashboardQueryState error={statusError} retry={refetchStatus} />
      {pollMutation.error && <p role="alert" className="text-xs text-destructive">Gmail check failed: {pollMutation.error.message}</p>}
      {hasIssue ? (
        <AlertCircle size={14} className="text-amber-600 dark:text-amber-400" />
      ) : (
        <Mail size={14} className="text-muted-foreground" />
      )}
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        Last Gmail Check:
      </span>
      <span className="text-[11px] font-bold text-foreground" data-testid="text-gmail-last-check">
        {isLoading ? "..." : formatTimeAgo(data?.gmailLastCheck ?? me?.gmailLastPollAt ?? null)}
      </span>

      {isStaleScan && pollHealth?.message && (
        <span
          className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 ml-1"
          data-testid="text-gmail-stale-warning"
        >
          {pollHealth.message}
        </span>
      )}
      {isHealthOtherIssue && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="text-gmail-health-warning">
          {pollHealth?.message ?? "Gmail monitoring is unavailable. Review the inbox connection and settings."}
        </p>
      )}
      {isHealthAuthRevoked && !showLinkCta && (
        <a
          href="/api/auth/link-gmail"
          className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline"
          data-testid="link-relink-gmail-revoked"
        >
          {pollHealth?.message ?? "Google access was revoked — reconnect Gmail."} →
        </a>
      )}

      {notConfigured && (
        <a
          href="/settings"
          className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline"
          data-testid="link-connect-gmail"
        >
          Connect Gmail to enable inbox monitoring →
        </a>
      )}
      {showLinkCta && (
        <a
          href="/api/auth/link-gmail"
          className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline"
          data-testid="link-link-gmail-inbox"
          title={
            isAuthRevoked
              ? "Your Google account revoked access. Re-link to resume polling."
              : "Grant Gmail read access so ArchiTrak can scan your inbox for devis PDFs every 15 minutes."
          }
        >
          {meLinked && isAuthRevoked
            ? "Re-link your inbox (access revoked) →"
            : meLinked
            ? "Re-link your inbox →"
            : "Link my inbox to enable monitoring →"}
        </a>
      )}
      {!notConfigured && !isPermsError && !showLinkCta && isOtherError && (
        <span
          className="text-[10px] text-amber-700 dark:text-amber-300 ml-1"
          title={data?.gmailLastPollError ?? undefined}
          data-testid="text-gmail-error"
        >
          Last poll errored — will retry automatically.
        </span>
      )}
      {!notConfigured && !isPermsError && !isOtherError && pollingDisabled && (
        <span className="text-[10px] text-amber-700 dark:text-amber-300 ml-1">
          (Polling paused)
        </span>
      )}

      {needsAttentionCount > 0 && (
        <Link
          href="/documents?filter=needs_attention"
          className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline"
          data-testid="link-email-docs-need-attention"
        >
          <span
            className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold no-underline"
            data-testid="badge-email-docs-need-attention"
          >
            {needsAttentionCount}
          </span>
          emailed document{needsAttentionCount === 1 ? "" : "s"} need{needsAttentionCount === 1 ? "s" : ""} review →
        </Link>
      )}

      {/* Task #506 — stuck-message alert */}
      {persistentFailureCount > 0 && (
        <button
          onClick={() => setShowStuckDialog(true)}
          className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline bg-transparent border-0 p-0 cursor-pointer"
          data-testid="link-gmail-stuck-messages"
        >
          <span
            className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold no-underline"
            data-testid="badge-gmail-stuck-messages"
          >
            {persistentFailureCount}
          </span>
          inbox message{persistentFailureCount === 1 ? "" : "s"} stuck — click to manage →
        </button>
      )}

      <div className="ml-auto">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[10px] font-semibold uppercase tracking-wider"
          disabled={pollMutation.isPending || !data?.gmailConfigured || !meLinked || !!meError}
          onClick={() => pollMutation.mutate()}
          data-testid="button-poll-gmail-now"
        >
          <RefreshCw size={12} className={`mr-1 ${pollMutation.isPending ? "animate-spin" : ""}`} />
          {pollMutation.isPending ? "Checking..." : "Check now"}
        </Button>
      </div>

      {/* Task #506 — dialog to inspect and skip persistent failures */}
      <StuckMessagesDialog open={showStuckDialog} onClose={() => setShowStuckDialog(false)} />
    </div>
  );
}

/** Task #539 — a ready-but-unsent certificat as reported by the server. */
interface UnsentCertificat {
  certificatId: number;
  certificateRef: string;
  certificateStatus: string;
  netToPayTtc: string;
  isSolde: boolean;
  projectId: number;
  projectName: string;
  contractorId: number;
  contractorName: string;
}

/**
 * Task #539 — "Awaiting certificat send" alert. Certificats that are ready
 * but never queued/sent are an important workflow stage that used to be
 * invisible outside each project. Card with count → dialog listing them,
 * modeled on the stuck-Gmail-messages dialog, with a per-row Send reusing
 * the exact same endpoint as the Communications tab.
 */
function UnsentCertificatsAlert() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const { data: unsent, isLoading, error, refetch } = useQuery<UnsentCertificat[]>({
    queryKey: ["/api/certificats/unsent"],
  });

  const sendMutation = useInvoiceAwareCertificatSend<unknown, UnsentCertificat>({
    target: (cert) => ({ projectId: cert.projectId, certId: cert.certificatId }),
    onSuccess: (_data, cert) => {
      toast({ title: "Certificat sent", description: cert.certificateRef });
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(cert.projectId), "certificats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(cert.projectId), "communications"] });
    },
    onError: (err: Error) => {
      toast({ title: "Send failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <>
      {sendMutation.confirmationDialog}
      <DashboardDisclosure title="Certificates awaiting dispatch" count={unsent?.length} defaultOpen
        summary="No successful client email recorded · dispatch task, not a payment request"
        issue={isLoading || error ? <DashboardQueryState loading={isLoading} error={error} retry={refetch} /> : undefined}>
      {unsent?.length === 0 && <p className="text-xs text-muted-foreground">No certificates awaiting email.</p>}
      {!!unsent?.length && <>
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left bg-transparent border-0 p-0 cursor-pointer"
        data-testid="card-unsent-certificats"
      >
        <LuxuryCard className="hover-elevate transition-all !rounded-lg !p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                <Award size={14} className="text-amber-500" />
              </div>
              <span className="text-[12px] text-foreground">
                Review dispatch — {unsent.length} certificat{unsent.length === 1 ? "" : "s"} not emailed
              </span>
            </div>
            <span
              className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-amber-500 text-white text-[11px] font-bold shrink-0"
              data-testid="badge-unsent-certificats-count"
            >
              {unsent.length}
            </span>
          </div>
        </LuxuryCard>
      </button>
      <div className="mt-2 divide-y divide-border">
        {unsent.map((cert) => (
          <div key={cert.certificatId} className="flex flex-wrap items-center gap-3 py-3" data-testid={`dispatch-summary-${cert.certificatId}`}>
            <div className="min-w-0 flex-1">
              <Link href={`/projets/${cert.projectId}`} className="text-xs font-semibold hover:underline">{cert.certificateRef}{cert.isSolde ? " · final certificate" : ""}</Link>
              <p className="text-[10px] text-muted-foreground">{cert.projectName} · {cert.contractorName}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{cert.certificateStatus === "sent" ? "Marked sent · no successful email recorded" : "No successful client email recorded"}</p>
            </div>
            <Button variant="outline" size="sm" className="text-[10px]" onClick={() => setOpen(true)}>Review dispatch</Button>
          </div>
        ))}
      </div>
      </>}
      </DashboardDisclosure>
      <Dialog open={open} onOpenChange={(v) => { if (!v) setOpen(false); }}>
        <DialogContent className="max-w-lg" data-testid="dialog-unsent-certificats">
          <DialogHeader>
            <DialogTitle>Certificats awaiting email</DialogTitle>
            <DialogDescription>
              These certificats de paiement do not have a successful client email on record.
              Send them here, or open the project for the full context.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {unsent?.map((cert) => (
              <div
                key={cert.certificatId}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
                data-testid={`row-unsent-certificat-${cert.certificatId}`}
              >
                <div className="min-w-0">
                  <ArchitectInvoiceBadge certId={cert.certificatId} />
                  <Link href={`/projets/${cert.projectId}`} onClick={() => setOpen(false)}>
                    <p className="text-[11px] font-semibold text-foreground truncate underline-offset-2 hover:underline cursor-pointer">
                      {cert.projectName} — {cert.certificateRef}
                      {cert.isSolde ? " (solde)" : ""}
                    </p>
                  </Link>
                  <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                    {cert.contractorName} · <Amount value={parseFloat(cert.netToPayTtc)} denomination="TTC" />
                  </p>
                  {cert.certificateStatus === "sent" && (
                    <p
                      className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-300"
                      data-testid={`label-false-sent-certificat-${cert.certificatId}`}
                    >
                      Marked sent · not emailed
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[10px] shrink-0"
                  disabled={sendMutation.isPending}
                  onClick={() => sendMutation.mutate(cert)}
                  data-testid={`button-send-unsent-certificat-${cert.certificatId}`}
                >
                  Send
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Task #506 — dialog listing Gmail messages that have failed N consecutive polls. */
function StuckMessagesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const { data: stuckMessages, isLoading, error, refetch } = useQuery<
    { userId: number; messageId: string; failCount: number; lastFailedAt: string }[]
  >({
    queryKey: ["/api/gmail/stuck-messages"],
    enabled: open,
  });

  const skipMutation = useMutation({
    mutationFn: async ({ userId, messageId }: { userId: number; messageId: string }) => {
      const res = await apiRequest("POST", `/api/gmail/stuck-messages/${encodeURIComponent(messageId)}/skip`, {
        userId,
        reason: "Manually skipped by operator from dashboard",
      });
      return res.json();
    },
    onSuccess: (_data, { messageId }) => {
      toast({ title: "Message skipped", description: `Message ${messageId.slice(0, 16)}… will no longer be retried.` });
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/gmail/status"] });
    },
    onError: (err: Error) => {
      toast({ title: "Skip failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-stuck-gmail-messages">
        <DialogHeader>
          <DialogTitle>Stuck Gmail messages</DialogTitle>
          <DialogDescription>
            These messages have failed {"\u2265"}5 consecutive inbox scans (e.g. corrupt attachment).
            Skipping stops future retries — the original email is never deleted.
          </DialogDescription>
        </DialogHeader>
        {isLoading && <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>}
        <DashboardQueryState error={error} retry={refetch} />
        {!isLoading && !error && stuckMessages?.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">No stuck messages — all clear.</p>
        )}
        {!isLoading && stuckMessages && stuckMessages.length > 0 && (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {stuckMessages.map((msg) => (
              <div
                key={`${msg.userId}:${msg.messageId}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
                data-testid={`row-stuck-message-${msg.messageId}`}
              >
                <div className="min-w-0">
                  <p className="text-[11px] font-mono text-foreground truncate">{msg.messageId}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {msg.failCount} failure{msg.failCount === 1 ? "" : "s"} · last{" "}
                    {formatTimeAgo(msg.lastFailedAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[10px] shrink-0"
                  disabled={skipMutation.isPending}
                  onClick={() => skipMutation.mutate({ userId: msg.userId, messageId: msg.messageId })}
                  data-testid={`button-skip-stuck-message-${msg.messageId}`}
                >
                  Skip
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function formatTimeAgo(isoString: string | null): string {
  if (!isoString) return "Never";
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min${mins > 1 ? "s" : ""} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

interface ProjectSummary {
  id: number;
  name: string;
  code: string;
  clientName: string;
  status: string;
  devisCount: number;
  devisApprovedCount: number;
  devisUnapprovedCount: number;
  allDevisSigned: boolean;
  invoiceCount: number;
  invoiceApprovedCount: number;
  invoiceUnapprovedCount: number;
  agentStatus: string;
  agentIssueCount: number;
}

interface ActivityItem {
  type: string;
  label: string;
  date: string | null;
  amount: string;
  projectId: number;
  contractor: string;
}

interface UrgentItem {
  type: string;
  label: string;
  projectId: number;
  id: number;
  amount: string;
}

interface DashboardData {
  gmailLastCheck: string | null;
  gmailPolling: boolean;
  gmailConfigured: boolean;
  gmailLastPollStatus: string;
  gmailLastPollError: string | null;
  overview: {
    activeProjects: number;
    totalProjects: number;
  };
  projectSummaries: ProjectSummary[];
  recentActivity: ActivityItem[];
  urgentItems: UrgentItem[];
}

export default function Dashboard() {
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const { data, isLoading, error, refetch } = useQuery<DashboardData>({
    queryKey: ["/api/dashboard/summary"],
  });

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
              Dashboard
            </h1>
            <p className="text-[11px] text-muted-foreground mt-1">
              Priority actions and project overview
            </p>
          </div>
          <a href="#dashboard-projects" className="shrink-0 rounded border border-border px-3 py-2 text-xs hover:bg-muted">Your projects ↓</a>
        </div>

        <GmailStatusBar isLoading={isLoading} data={data} />
        <DashboardQueryState loading={isLoading} error={error} retry={refetch} />
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-1">
            <h2 className="text-sm font-semibold">Decisions &amp; next steps</h2>
            <p className="text-[10px] text-muted-foreground">Counts are per source, not additive</p>
          </div>
        <DashboardDisclosure title="Urgent items" count={data?.urgentItems.length} defaultOpen priority
          summary={isLoading ? "Loading actions…" : error ? "Actions could not be refreshed" : "Source-flagged actions · review the record before acting"}>
        {data?.urgentItems.length === 0 && <p className="text-xs text-muted-foreground">No urgent items reported.</p>}
        {data && (
          <div>
            <div className="space-y-2">
              {data.urgentItems.map((item, idx) => (
                  <LuxuryCard
                    key={`${item.type}-${item.id}`}
                    className="!rounded-lg !p-3"
                    data-testid={`card-urgent-${idx}`}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 xl:grid-cols-[minmax(0,1fr)_auto_8rem]">
                      <div className="flex items-start gap-3 min-w-0">
                        {item.type === "overdue_invoice" && (
                          <div className="p-1.5 rounded-lg bg-red-50 dark:bg-red-950/30">
                            <Receipt size={14} className="text-red-500" />
                          </div>
                        )}
                        {(item.type === "cert_draft" || item.type === "cert_review") && (
                          <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                            <Award size={14} className="text-amber-500" />
                          </div>
                        )}
                        {item.type === "anomaly" && (
                          <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                            <AlertTriangle size={14} className="text-amber-500" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-[12px] font-semibold text-foreground" data-testid={`text-urgent-label-${idx}`}>
                            {item.label}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {data.projectSummaries.find((project) => project.id === item.projectId)?.name}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`text-urgent-next-step-${idx}`}>
                            {item.type === "overdue_invoice"
                              ? "Waiting on payment · review the record before following up"
                              : item.type === "cert_draft"
                              ? "Your action · complete the certificate"
                              : item.type === "cert_review"
                              ? "Your action · review the certificate"
                              : "Your action · resolve the quotation queries"}
                          </p>
                        </div>
                      </div>
                      <span className="whitespace-nowrap text-right text-[12px] font-semibold text-foreground" data-testid={`text-urgent-amount-${idx}`}>
                        {parseFloat(item.amount) > 0 && <Amount value={parseFloat(item.amount)} denomination="TTC" />}
                      </span>
                      <Link href={`/projets/${item.projectId}`}
                        className="col-span-2 inline-flex min-h-9 w-32 items-center justify-center gap-1 rounded border border-border px-2 py-2 text-center text-[11px] font-semibold hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary justify-self-end xl:col-span-1">
                        {item.type === "overdue_invoice" ? "Review invoice" : item.type === "cert_draft" ? "Continue draft" : item.type === "cert_review" ? "Review certificate" : "Review queries"}
                        <span aria-hidden="true">↗</span>
                      </Link>
                    </div>
                  </LuxuryCard>
              ))}
            </div>
          </div>
        )}
        </DashboardDisclosure>

        <UnsentCertificatsAlert />
        <DesignFeeActionsStrip />
        <DetectedFeeInvoicesAlert />
        <p className="pt-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Supporting context</p>
        <AccountingReferences />

        <DashboardDisclosure title="Project financial health"
          summary={`Contract value versus certified value · ${data?.projectSummaries.length ?? "…"} projects`}>
        {data && data.projectSummaries.length > 0 ? (
          <div>
            <LuxuryCard className="!p-0 !rounded-none !border-0 !shadow-none" data-testid="card-burn-up">
              <div className="mb-3">
                <Select
                  value={selectedProjectId?.toString() ?? ""}
                  onValueChange={(val) => setSelectedProjectId(val ? parseInt(val, 10) : null)}
                >
                  <SelectTrigger aria-label="Financial health project" className="w-full max-w-xs" data-testid="select-burnup-project">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {data.projectSummaries.map((ps) => (
                      <SelectItem key={ps.id} value={ps.id.toString()} data-testid={`option-project-${ps.id}`}>
                        {ps.code} — {ps.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedProjectId ? (
                <BurnUpChart projectId={selectedProjectId} />
              ) : (
                <div className="flex items-center justify-center h-[200px] text-muted-foreground text-[12px]" data-testid="text-select-project-prompt">
                  Select a project to view its burn-up chart.
                </div>
              )}
            </LuxuryCard>
          </div>
        ) : <p className="text-xs text-muted-foreground">{isLoading ? "Loading projects…" : error ? "Project data unavailable." : "No projects available."}</p>}
        </DashboardDisclosure>
        <RecentActivity items={data?.recentActivity} isLoading={isLoading} error={error} />
        </div>

        <aside id="dashboard-projects" tabIndex={-1} aria-label="Your projects" className="min-w-0 scroll-mt-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1">
            <h2 className="text-sm font-semibold">Your projects</h2>
            <p className="text-[10px] text-muted-foreground">
              {data ? `${data.overview.activeProjects} active of ${data.overview.totalProjects} total` : isLoading ? "Loading projects…" : "Project overview unavailable"}
            </p>
          </div>

          <DashboardDisclosure title="Project directory" count={data?.projectSummaries.length} defaultOpen
            summary={data ? `${data.overview.activeProjects} active of ${data.overview.totalProjects} total` : isLoading ? "Loading projects…" : "Project overview unavailable"}>
          {isLoading ? (
            <div className="space-y-3 mt-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <LuxuryCard key={i}>
                  <Skeleton className="h-4 w-48 mb-2" />
                  <Skeleton className="h-3 w-32" />
                </LuxuryCard>
              ))}
            </div>
          ) : error && !data ? (
            <p className="mt-3 text-xs text-destructive">Projects could not be loaded. Use Retry above.</p>
          ) : data && data.projectSummaries.length > 0 ? (
            <div className="mt-3">
              <div className="space-y-2">
                {data.projectSummaries.map((ps) => (
                  <Link key={ps.id} href={`/projets/${ps.id}`}>
                    <LuxuryCard
                      className="cursor-pointer hover-elevate transition-all !p-4 !rounded-lg"
                      data-testid={`card-project-${ps.id}`}
                    >
                      <div className="space-y-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-semibold text-foreground" data-testid={`text-project-name-${ps.id}`}>
                              {ps.name}
                            </span>
                            <StatusBadge status={ps.status} />
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                            {ps.code} — {ps.clientName}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
                          <div>
                            <TechnicalLabel>Devis</TechnicalLabel>
                          <div className="mt-1 flex items-center gap-0.5">
                            <CounterCell
                              value={ps.devisApprovedCount}
                              variant={ps.devisApprovedCount > 0 ? "green" : "neutral"}
                              testId={`cell-devis-approved-${ps.id}`}
                              hint="Devis approved"
                            />
                            <CounterCell
                              value={ps.devisUnapprovedCount}
                              variant={ps.devisUnapprovedCount > 0 ? "red" : "neutral"}
                              testId={`cell-devis-unapproved-${ps.id}`}
                              hint="Devis pending approval"
                            />
                            <SignedIcon
                              allSigned={ps.allDevisSigned}
                              hasDevis={ps.devisCount > 0}
                              testId={`icon-signed-${ps.id}`}
                            />
                          </div>
                          </div>
                          <div>
                            <TechnicalLabel>Factures</TechnicalLabel>
                          <div className="mt-1 flex items-center gap-0.5">
                            <CounterCell
                              value={ps.invoiceApprovedCount}
                              variant={ps.invoiceApprovedCount > 0 ? "green" : "neutral"}
                              testId={`cell-factures-approved-${ps.id}`}
                              hint="Factures approved"
                            />
                            <CounterCell
                              value={ps.invoiceUnapprovedCount}
                              variant={ps.invoiceUnapprovedCount > 0 ? "red" : "neutral"}
                              testId={`cell-factures-unapproved-${ps.id}`}
                              hint="Factures pending approval"
                            />
                          </div>
                          </div>
                          <div>
                            <TechnicalLabel>Agent</TechnicalLabel>
                          <div className="mt-1 flex">
                            <AgentIcon
                              status={ps.agentStatus}
                              testId={`icon-agent-${ps.id}`}
                            />
                          </div>
                          </div>
                        </div>
                        <p className="text-[10px] text-muted-foreground">Counts: approved / pending · pen: signature status</p>
                        <p className="text-[10px] text-muted-foreground">
                          {ps.agentIssueCount} agent quer{ps.agentIssueCount === 1 ? "y" : "ies"} · Open project →
                        </p>
                      </div>
                    </LuxuryCard>
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            <LuxuryCard className="mt-3" data-testid="card-empty-projects">
              <p className="text-[12px] text-muted-foreground text-center py-8">
                No projects yet. Sync from ArchiDoc to get started.
              </p>
            </LuxuryCard>
          )}
          </DashboardDisclosure>
          <p className="mt-3 text-[10px] text-muted-foreground">Open a project for the full picture. Section counts may refer to the same records.</p>
        </aside>
        </div>
      </div>
    </AppLayout>
  );
}

function AccountingReferences() {
  const { data, isLoading, error, refetch } = useQuery<OutstandingFeeSummary>({
    queryKey: ["/api/fees/outstanding"],
  });
  return (
    <DashboardDisclosure title="Accounting references to reconcile" count={data?.totalCount}
      summary={<>{data && <><Amount value={data.totalFeeHt} denomination="HT" /> in fee entries · </>}Missing Pennylane reference, not evidence of nonpayment</>}
      issue={isLoading || error ? <DashboardQueryState loading={isLoading} error={error} retry={refetch} /> : undefined}>
      <div data-testid="section-outstanding-fees-dashboard">
        <p className="mb-3 text-[11px] text-muted-foreground">Approved invoices missing a Pennylane commission reference. Entry age is not payment lateness; detected-document matches are unverified.</p>
        <OutstandingFeesPanel scope="global" />
      </div>
    </DashboardDisclosure>
  );
}

function RecentActivity({ items, isLoading, error }: { items?: ActivityItem[]; isLoading: boolean; error: Error | null }) {
  return (
    <DashboardDisclosure title="Recent activity" count={items?.length}
      summary={isLoading ? "Loading updates…" : error ? "Activity could not be refreshed" : "Latest recorded updates · history, not a task list"}>
      <div data-testid="card-recent-activity" className="divide-y divide-border">
        {items?.length === 0 && <p className="text-xs text-muted-foreground">No recent activity recorded.</p>}
        {items?.slice(0, 5).map((item, idx) => (
          <Link key={idx} href={`/projets/${item.projectId}`}>
            <div className="flex flex-wrap items-center gap-3 py-3 hover:bg-muted/40" data-testid={`row-activity-${idx}`}>
              {item.type === "invoice" ? <Receipt size={14} className="shrink-0 text-muted-foreground" /> : <Award size={14} className="shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold" data-testid={`text-activity-label-${idx}`}>{item.label}</p>
                <p className="text-[10px] text-muted-foreground">{item.contractor}{item.date ? ` · ${item.date}` : ""}</p>
              </div>
              <span className="whitespace-nowrap text-xs" data-testid={`text-activity-amount-${idx}`}><Amount value={parseFloat(item.amount)} denomination="TTC" /></span>
            </div>
          </Link>
        ))}
      </div>
    </DashboardDisclosure>
  );
}

function CounterCell({ value, variant, testId, hint }: {
  value: number;
  variant: "green" | "red" | "neutral";
  testId: string;
  hint: string;
}) {
  const styles = {
    green: "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
    red: "bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800",
    neutral: "bg-muted/50 text-muted-foreground border-border",
  };

  return (
    <div
      className={`w-[34px] h-[34px] rounded-lg border flex items-center justify-center ${styles[variant]}`}
      data-testid={testId}
      title={hint}
    >
      <span className="text-[14px] font-bold">{value}</span>
    </div>
  );
}

function SignedIcon({ allSigned, hasDevis, testId }: {
  allSigned: boolean;
  hasDevis: boolean;
  testId: string;
}) {
  if (!hasDevis) {
    return (
      <div
        className="w-[34px] h-[34px] rounded-lg border border-border bg-muted/50 flex items-center justify-center"
        data-testid={testId}
        title="No devis"
      >
        <span className="text-muted-foreground text-[12px]">—</span>
      </div>
    );
  }

  return (
    <div
      className={`w-[34px] h-[34px] rounded-lg border flex items-center justify-center ${
        allSigned
          ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800"
          : "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800"
      }`}
      data-testid={testId}
      title={allSigned ? "All devis signed" : "Devis not yet signed"}
    >
      <PenLine size={14} className={allSigned ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"} />
    </div>
  );
}

function AgentIcon({ status, testId }: {
  status: string;
  testId: string;
}) {
  return (
    <div
      className={`w-[34px] h-[34px] rounded-lg border flex items-center justify-center ${
        status === "ok"
          ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800"
          : "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800"
      }`}
      data-testid={testId}
      title={status === "ok" ? "Agent status: all clear" : "Agent status: queries/anomalies need attention"}
    >
      {status === "ok" ? (
        <Check size={14} className="text-emerald-600 dark:text-emerald-400" />
      ) : (
        <HelpCircle size={14} className="text-amber-500 dark:text-amber-400" />
      )}
    </div>
  );
}
