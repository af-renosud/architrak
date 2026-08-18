import { useState } from "react";
import { Amount } from "@/components/ui/amount";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertCircle } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
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
  FolderOpen,
  AlertTriangle,
  Receipt,
  Award,
  Clock,
  Mail,
  PenLine,
  Check,
  HelpCircle,
  TrendingUp,
  Coins,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import BurnUpChart from "@/components/dashboard/BurnUpChart";
import { Briefcase, ReceiptEuro } from "lucide-react";
import { OutstandingFeesPanel } from "@/components/fees/OutstandingFeesPanel";
import { OutstandingFeesBanner } from "@/components/fees/OutstandingFeesBanner";

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
  const { data } = useQuery<{ id: number }[]>({
    queryKey: ["/api/architect-fee-invoices", { status: "pending_review" }],
    queryFn: async () => {
      const res = await fetch(`/api/architect-fee-invoices?status=pending_review`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });
  if (!data || data.length === 0) return null;
  return (
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
  );
}

function DesignFeeActionsStrip() {
  const { data } = useQuery<DesignContractDashboardAction[]>({
    queryKey: ["/api/design-contracts/dashboard-actions"],
  });
  if (!data || data.length === 0) return null;
  return (
    <div data-testid="strip-design-fee-actions">
      <SectionHeader icon={Briefcase} title="Design Fee Actions" subtitle="Reached milestones awaiting invoice" />
      <div className="space-y-2 mt-3">
        {data.map((a) => (
          <Link key={a.milestoneId} href={`/projets/${a.projectId}`}>
            <LuxuryCard className="cursor-pointer hover-elevate transition-all" data-testid={`card-design-action-${a.milestoneId}`}>
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
  const { data: me } = useQuery<{
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
  const { data: gmailStatus } = useQuery<{
    pollHealth?: { level: string; ageMs: number | null; message: string | null };
    needsProjectCount?: number;
    persistentFailureCount?: number;
  }>({
    queryKey: ["/api/gmail/status"],
  });
  const pollHealth = gmailStatus?.pollHealth;
  const needsProjectCount = gmailStatus?.needsProjectCount ?? 0;
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
  const showLinkCta = !notConfigured && (isNoLinkedUsers || isPermsError || (!meLinked && me !== undefined));
  const isHealthAuthRevoked = pollHealth?.level === "auth_revoked";
  const hasIssue =
    notConfigured || isPermsError || isNoLinkedUsers || isAuthRevoked || isOtherError ||
    pollingDisabled || !meLinked || isStaleScan || isHealthAuthRevoked || persistentFailureCount > 0;

  const tone = hasIssue
    ? "border-amber-300 bg-amber-50/70 dark:border-amber-700 dark:bg-amber-950/30"
    : "border-border bg-muted/50";

  return (
    <div
      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border ${tone}`}
      data-testid="bar-gmail-status"
    >
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

      {needsProjectCount > 0 && (
        <Link
          href="/documents?filter=needs_project"
          className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline"
          data-testid="link-email-docs-need-project"
        >
          <span
            className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold no-underline"
            data-testid="badge-email-docs-need-project"
          >
            {needsProjectCount}
          </span>
          emailed document{needsProjectCount === 1 ? "" : "s"} need{needsProjectCount === 1 ? "s" : ""} a project →
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
          disabled={pollMutation.isPending || !data?.gmailConfigured || !meLinked}
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
  const { data: unsent, refetch } = useQuery<UnsentCertificat[]>({
    queryKey: ["/api/certificats/unsent"],
  });

  const sendMutation = useMutation({
    mutationFn: async (cert: UnsentCertificat) => {
      const res = await apiRequest(
        "POST",
        `/api/projects/${cert.projectId}/certificats/${cert.certificatId}/send`,
      );
      return res.json();
    },
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

  if (!unsent || unsent.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left bg-transparent border-0 p-0 cursor-pointer"
        data-testid="card-unsent-certificats"
      >
        <LuxuryCard className="hover-elevate transition-all border-amber-400 border">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                <Award size={14} className="text-amber-500" />
              </div>
              <span className="text-[12px] text-foreground">
                Awaiting certificat send — {unsent.length} certificat{unsent.length === 1 ? "" : "s"} ready but not sent
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

      <Dialog open={open} onOpenChange={(v) => { if (!v) setOpen(false); }}>
        <DialogContent className="max-w-lg" data-testid="dialog-unsent-certificats">
          <DialogHeader>
            <DialogTitle>Certificats awaiting send</DialogTitle>
            <DialogDescription>
              These certificats de paiement are ready but have never been sent to the client.
              Send them here, or open the project for the full context.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {unsent.map((cert) => (
              <div
                key={cert.certificatId}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
                data-testid={`row-unsent-certificat-${cert.certificatId}`}
              >
                <div className="min-w-0">
                  <Link href={`/projets/${cert.projectId}`} onClick={() => setOpen(false)}>
                    <p className="text-[11px] font-semibold text-foreground truncate underline-offset-2 hover:underline cursor-pointer">
                      {cert.projectName} — {cert.certificateRef}
                      {cert.isSolde ? " (solde)" : ""}
                    </p>
                  </Link>
                  <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                    {cert.contractorName} · <Amount value={parseFloat(cert.netToPayTtc)} denomination="TTC" />
                  </p>
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
  const { data: stuckMessages, isLoading, refetch } = useQuery<
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
        {!isLoading && stuckMessages?.length === 0 && (
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
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/dashboard/summary"],
  });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
            Dashboard
          </h1>
          <p className="text-[11px] text-muted-foreground mt-1">
            Overview of your projects and activity
          </p>
        </div>

        <OutstandingFeesBanner scope="global" href="/honoraires" />

        <GmailStatusBar isLoading={isLoading} data={data} />

        {isLoading ? (
          <LuxuryCard>
            <div className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="h-3 w-48" />
            </div>
          </LuxuryCard>
        ) : data && data.recentActivity.length > 0 ? (
          <div>
            <SectionHeader
              icon={Clock}
              title="Recent Activity"
              subtitle="Latest updates"
            />
            <LuxuryCard className="mt-3" data-testid="card-recent-activity">
              <div className="divide-y divide-[rgba(0,0,0,0.04)] dark:divide-[rgba(255,255,255,0.04)]">
                {data.recentActivity.slice(0, 5).map((item, idx) => (
                  <Link key={idx} href={`/projets/${item.projectId}`}>
                    <div
                      className="flex items-center gap-3 py-2.5 cursor-pointer hover-elevate px-1 -mx-1 rounded-lg"
                      data-testid={`row-activity-${idx}`}
                    >
                      <div className={`p-1.5 rounded-lg shrink-0 ${
                        item.type === "invoice"
                          ? "bg-blue-50 dark:bg-blue-950/30"
                          : "bg-emerald-50 dark:bg-emerald-950/30"
                      }`}>
                        {item.type === "invoice" ? (
                          <Receipt size={12} className="text-blue-500 dark:text-blue-400" />
                        ) : (
                          <Award size={12} className="text-emerald-500 dark:text-emerald-400" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-semibold text-foreground truncate" data-testid={`text-activity-label-${idx}`}>
                          {item.label}
                        </p>
                        <p className="text-[10px] text-muted-foreground truncate">
                          {item.contractor}{item.date ? ` · ${item.date}` : ""}
                        </p>
                      </div>
                      <span className="text-[11px] font-semibold text-foreground whitespace-nowrap shrink-0" data-testid={`text-activity-amount-${idx}`}>
                        <Amount value={parseFloat(item.amount)} denomination="TTC" />
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </LuxuryCard>
          </div>
        ) : null}

        <div data-testid="section-outstanding-fees-dashboard">
          <SectionHeader
            icon={Coins}
            title="Outstanding Architect Fees"
            subtitle="Approved invoices missing a Penny Lane reference"
          />
          <div className="mt-3">
            <OutstandingFeesPanel scope="global" />
          </div>
        </div>

        <DetectedFeeInvoicesAlert />

        <DesignFeeActionsStrip />

        <UnsentCertificatsAlert />

        {data && data.urgentItems.length > 0 && (
          <div>
            <SectionHeader
              icon={AlertTriangle}
              title="Urgent Items"
              subtitle="Actions required"
            />
            <div className="space-y-2 mt-3">
              {data.urgentItems.map((item, idx) => (
                <Link key={idx} href={`/projets/${item.projectId}`}>
                  <LuxuryCard
                    className="cursor-pointer hover-elevate transition-all"
                    data-testid={`card-urgent-${idx}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
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
                        <span className="text-[12px] text-foreground" data-testid={`text-urgent-label-${idx}`}>
                          {item.label}
                        </span>
                      </div>
                      {parseFloat(item.amount) > 0 && (
                        <span className="text-[12px] font-semibold text-foreground" data-testid={`text-urgent-amount-${idx}`}>
                          <Amount value={parseFloat(item.amount)} denomination="TTC" />
                        </span>
                      )}
                    </div>
                  </LuxuryCard>
                </Link>
              ))}
            </div>
          </div>
        )}

        {data && data.projectSummaries.length > 0 && (
          <div>
            <SectionHeader
              icon={TrendingUp}
              title="Project Financial Health"
              subtitle="Burn-up chart"
            />
            <LuxuryCard className="mt-3" data-testid="card-burn-up">
              <div className="mb-3">
                <Select
                  value={selectedProjectId?.toString() ?? ""}
                  onValueChange={(val) => setSelectedProjectId(val ? parseInt(val, 10) : null)}
                >
                  <SelectTrigger className="w-full max-w-xs" data-testid="select-burnup-project">
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
        )}

        <div>
          <SectionHeader
            icon={FolderOpen}
            title="Projects"
            subtitle={`${data?.overview.activeProjects ?? 0} active of ${data?.overview.totalProjects ?? 0} total`}
          />

          {isLoading ? (
            <div className="space-y-3 mt-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <LuxuryCard key={i}>
                  <Skeleton className="h-4 w-48 mb-2" />
                  <Skeleton className="h-3 w-32" />
                </LuxuryCard>
              ))}
            </div>
          ) : data && data.projectSummaries.length > 0 ? (
            <div className="mt-3">
              <div className="flex items-end mb-2 px-2">
                <div className="flex-1" />
                <div className="flex items-end" style={{ gap: "2px" }}>
                  <div className="w-[120px] text-center">
                    <TechnicalLabel>Devis</TechnicalLabel>
                  </div>
                  <div className="w-[96px] text-center">
                    <TechnicalLabel>Factures</TechnicalLabel>
                  </div>
                  <div className="w-[48px] text-center">
                    <TechnicalLabel>Agent</TechnicalLabel>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {data.projectSummaries.map((ps) => (
                  <Link key={ps.id} href={`/projets/${ps.id}`}>
                    <LuxuryCard
                      className="cursor-pointer hover-elevate transition-all !py-3"
                      data-testid={`card-project-${ps.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold text-foreground truncate" data-testid={`text-project-name-${ps.id}`}>
                              {ps.name}
                            </span>
                            <StatusBadge status={ps.status} />
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                            {ps.code} — {ps.clientName}
                          </p>
                        </div>

                        <div className="flex items-center shrink-0" style={{ gap: "2px" }}>
                          <div className="flex items-center gap-0.5 w-[120px] justify-center">
                            <CounterCell
                              value={ps.devisApprovedCount}
                              variant={ps.devisApprovedCount > 0 ? "green" : "neutral"}
                              testId={`cell-devis-approved-${ps.id}`}
                              hint="Number of devis"
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

                          <div className="flex items-center gap-0.5 w-[96px] justify-center">
                            <CounterCell
                              value={ps.invoiceApprovedCount}
                              variant={ps.invoiceApprovedCount > 0 ? "green" : "neutral"}
                              testId={`cell-factures-approved-${ps.id}`}
                              hint="Number of factures"
                            />
                            <CounterCell
                              value={ps.invoiceUnapprovedCount}
                              variant={ps.invoiceUnapprovedCount > 0 ? "red" : "neutral"}
                              testId={`cell-factures-unapproved-${ps.id}`}
                              hint="Factures pending approval"
                            />
                          </div>

                          <div className="w-[48px] flex justify-center">
                            <AgentIcon
                              status={ps.agentStatus}
                              testId={`icon-agent-${ps.id}`}
                            />
                          </div>
                        </div>
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
        </div>
      </div>
    </AppLayout>
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
