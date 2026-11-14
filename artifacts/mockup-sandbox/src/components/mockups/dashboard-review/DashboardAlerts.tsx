import { useState } from "react";
import { AlertCircle, Award, Briefcase, Mail, Paperclip, ReceiptEuro, RefreshCw } from "lucide-react";
import { Amount, Button, LuxuryCard, SectionHeader } from "./ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./overlays";
import { Link, sandboxNotice, useQuery } from "./stubs";
import type { dashboardSample, designActionsSample, stuckMessagesSample, unsentSample } from "./fixtures";

export function DetectedFeeInvoicesAlert() {
  const { data } = useQuery<{ id: number }[]>({ queryKey: ["/api/architect-fee-invoices", { status: "pending_review" }] });
  if (!data || data.length === 0) return null;
  return <Link href="/honoraires/factures-detectees">
    <div className="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 cursor-pointer hover-elevate" data-testid="alert-pending-fee-invoices">
      <ReceiptEuro size={14} className="text-amber-600 shrink-0" />
      <p className="text-xs text-amber-900 dark:text-amber-200">{data.length === 1 ? "1 facture d'honoraires détectée attend votre vérification." : `${data.length} factures d'honoraires détectées attendent votre vérification.`}</p>
    </div>
  </Link>;
}
export function DesignFeeActionsStrip() {
  const { data } = useQuery<typeof designActionsSample>({ queryKey: ["/api/design-contracts/dashboard-actions"] });
  if (!data || data.length === 0) return null;
  return <div data-testid="strip-design-fee-actions">
    <SectionHeader icon={Briefcase} title="Design Fee Actions" subtitle="Reached milestones awaiting invoice" />
    <div className="space-y-2 mt-3">
      {data.map((a) => (
        <Link key={a.milestoneId} href={`/projets/${a.projectId}`}>
          <LuxuryCard className="cursor-pointer hover-elevate transition-all" data-testid={`card-design-action-${a.milestoneId}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30"><Briefcase size={14} className="text-amber-500" /></div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-foreground truncate">{a.labelFr}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{a.projectCode} · {a.projectName}</p>
                </div>
              </div>
              <span className="text-[11px] font-semibold text-foreground whitespace-nowrap shrink-0"><Amount value={parseFloat(a.amountTtc)} denomination="TTC" /></span>
            </div>
          </LuxuryCard>
        </Link>
      ))}
    </div>
  </div>;
}
export function GmailStatusBar({ isLoading, data }: { isLoading: boolean; data: typeof dashboardSample | undefined }) {
  const { data: me } = useQuery<{ id: number; email: string; gmailLinked?: boolean; gmailLastPollAt?: string | null }>({ queryKey: ["/api/auth/user"] });
  const { data: gmailStatus } = useQuery<{ pollHealth?: { level: string; ageMs: number | null; message: string | null }; needsAttentionCount?: number; needsProjectCount?: number; persistentFailureCount?: number }>({ queryKey: ["/api/gmail/status"] });
  const pollHealth = gmailStatus?.pollHealth;
  const needsAttentionCount = gmailStatus?.needsAttentionCount ?? gmailStatus?.needsProjectCount ?? 0;
  const persistentFailureCount = gmailStatus?.persistentFailureCount ?? 0;
  const [showStuckDialog, setShowStuckDialog] = useState(false);
  const isStaleScan = pollHealth?.level === "stale" || pollHealth?.level === "never";
  const status = data?.gmailLastPollStatus ?? "idle";
  const isPermsError = status === "insufficient_permissions";
  const isNoLinkedUsers = status === "no_linked_users";
  const isAuthRevoked = status === "auth_revoked";
  const isOtherError = status === "error";
  const notConfigured = data && !data.gmailConfigured;
  const pollingDisabled = data && data.gmailConfigured && !data.gmailPolling;
  const meLinked = me?.gmailLinked === true;
  const showLinkCta = !notConfigured && (isNoLinkedUsers || isPermsError || (!meLinked && me !== undefined));
  const isHealthAuthRevoked = pollHealth?.level === "auth_revoked";
  const hasIssue = notConfigured || isPermsError || isNoLinkedUsers || isAuthRevoked || isOtherError || pollingDisabled || !meLinked || isStaleScan || isHealthAuthRevoked || persistentFailureCount > 0;
  const tone = hasIssue ? "border-amber-300 bg-amber-50/70 dark:border-amber-700 dark:bg-amber-950/30" : "border-border bg-muted/50";
  // Mutation hook boundary: never polls a real inbox.
  const pollMutation = { isPending: false, mutate: () => sandboxNotice("Check Gmail inbox") };
  return (
    <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border ${tone}`} data-testid="bar-gmail-status">
      {hasIssue ? <AlertCircle size={14} className="text-amber-600 dark:text-amber-400" /> : <Mail size={14} className="text-muted-foreground" />}
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Last Gmail Check:</span>
      <span className="text-[11px] font-bold text-foreground" data-testid="text-gmail-last-check">{isLoading ? "..." : formatTimeAgo(data?.gmailLastCheck ?? me?.gmailLastPollAt ?? null)}</span>
      {isStaleScan && pollHealth?.message && <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 ml-1" data-testid="text-gmail-stale-warning">{pollHealth.message}</span>}
      {isHealthAuthRevoked && !showLinkCta && (
        <Link href="/api/auth/link-gmail" className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline" data-testid="link-relink-gmail-revoked">{pollHealth?.message ?? "Google access was revoked — reconnect Gmail."} →</Link>
      )}
      {notConfigured && <Link href="/settings" className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline" data-testid="link-connect-gmail">Connect Gmail to enable inbox monitoring →</Link>}
      {showLinkCta && (
        <Link href="/api/auth/link-gmail" className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline" data-testid="link-link-gmail-inbox" title={isAuthRevoked ? "Your Google account revoked access. Re-link to resume polling." : "Grant Gmail read access so ArchiTrak can scan your inbox for devis PDFs every 15 minutes."}>
          {meLinked && isAuthRevoked ? "Re-link your inbox (access revoked) →" : meLinked ? "Re-link your inbox →" : "Link my inbox to enable monitoring →"}
        </Link>
      )}
      {!notConfigured && !isPermsError && !showLinkCta && isOtherError && <span className="text-[10px] text-amber-700 dark:text-amber-300 ml-1" title={data?.gmailLastPollError ?? undefined} data-testid="text-gmail-error">Last poll errored — will retry automatically.</span>}
      {!notConfigured && !isPermsError && !isOtherError && pollingDisabled && <span className="text-[10px] text-amber-700 dark:text-amber-300 ml-1">(Polling paused)</span>}
      {needsAttentionCount > 0 && (
        <Link href="/documents?filter=needs_attention" className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline" data-testid="link-email-docs-need-attention">
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold no-underline" data-testid="badge-email-docs-need-attention">{needsAttentionCount}</span>
          emailed document{needsAttentionCount === 1 ? "" : "s"} need{needsAttentionCount === 1 ? "s" : ""} review →
        </Link>
      )}
      {persistentFailureCount > 0 && (
        <button onClick={() => setShowStuckDialog(true)} className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 underline ml-1 hover:no-underline bg-transparent border-0 p-0 cursor-pointer" data-testid="link-gmail-stuck-messages">
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold no-underline" data-testid="badge-gmail-stuck-messages">{persistentFailureCount}</span>
          inbox message{persistentFailureCount === 1 ? "" : "s"} stuck — click to manage →
        </button>
      )}
      <div className="ml-auto">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] font-semibold uppercase tracking-wider" disabled={pollMutation.isPending || !data?.gmailConfigured || !meLinked} onClick={() => pollMutation.mutate()} data-testid="button-poll-gmail-now">
          <RefreshCw size={12} className={`mr-1 ${pollMutation.isPending ? "animate-spin" : ""}`} />{pollMutation.isPending ? "Checking..." : "Check now"}
        </Button>
      </div>
      <StuckMessagesDialog open={showStuckDialog} onClose={() => setShowStuckDialog(false)} />
    </div>
  );
}
function StuckMessagesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: stuckMessages, isLoading } = useQuery<typeof stuckMessagesSample>({ queryKey: ["/api/gmail/stuck-messages"], enabled: open });
  const skipMutation = { isPending: false, mutate: ({ messageId }: { userId: number; messageId: string }) => sandboxNotice(`Skip message ${messageId}`) };
  return <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
    <DialogContent className="max-w-lg" data-testid="dialog-stuck-gmail-messages">
      <DialogHeader>
        <DialogTitle>Stuck Gmail messages</DialogTitle>
        <DialogDescription>These messages have failed {"\u2265"}5 consecutive inbox scans (e.g. corrupt attachment). Skipping stops future retries — the original email is never deleted.</DialogDescription>
      </DialogHeader>
      {isLoading && <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>}
      {!isLoading && stuckMessages?.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">No stuck messages — all clear.</p>}
      {!isLoading && stuckMessages && stuckMessages.length > 0 && (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {stuckMessages.map((msg) => (
            <div key={`${msg.userId}:${msg.messageId}`} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2" data-testid={`row-stuck-message-${msg.messageId}`}>
              <div className="min-w-0">
                <p className="text-[11px] font-mono text-foreground truncate">{msg.messageId}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{msg.failCount} failure{msg.failCount === 1 ? "" : "s"} · last{" "}{formatTimeAgo(msg.lastFailedAt)}</p>
              </div>
              <Button variant="outline" size="sm" className="h-7 px-2 text-[10px] shrink-0" disabled={skipMutation.isPending} onClick={() => skipMutation.mutate({ userId: msg.userId, messageId: msg.messageId })} data-testid={`button-skip-stuck-message-${msg.messageId}`}>Skip</Button>
            </div>
          ))}
        </div>
      )}
    </DialogContent>
  </Dialog>;
}
// ArchitectInvoiceBadge's visual source copied; its external attachment manager
// is a stub boundary rather than an upload/PDF/delete path in a dashboard mockup.
function ArchitectInvoiceBadge({ certId }: { certId: number }) {
  return <button type="button" className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[9px] text-muted-foreground hover:bg-accent text-left" onClick={() => sandboxNotice("Gérer la facture d’architecte")} data-testid={`architect-invoice-badge-${certId}`} title="Gérer la facture d’architecte">
    <Paperclip size={10} />{certId === 2 ? "Facture d’architecte jointe" : "Sans facture d’architecte"}
  </button>;
}
export function UnsentCertificatsAlert() {
  const [open, setOpen] = useState(false);
  const { data: unsent } = useQuery<typeof unsentSample>({ queryKey: ["/api/certificats/unsent"] });
  // Invoice-aware send hook is a service/flow boundary: no send or upload occurs.
  const sendMutation = { isPending: false, mutate: (cert: typeof unsentSample[number]) => sandboxNotice(`Send certificat ${cert.certificateRef}`) };
  if (!unsent || unsent.length === 0) return null;
  return <>
    <button onClick={() => setOpen(true)} className="w-full text-left bg-transparent border-0 p-0 cursor-pointer" data-testid="card-unsent-certificats">
      <LuxuryCard className="hover-elevate transition-all border-amber-400 border">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30"><Award size={14} className="text-amber-500" /></div>
            <span className="text-[12px] text-foreground">Awaiting certificat email — {unsent.length} certificat{unsent.length === 1 ? "" : "s"} not emailed</span>
          </div>
          <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-amber-500 text-white text-[11px] font-bold shrink-0" data-testid="badge-unsent-certificats-count">{unsent.length}</span>
        </div>
      </LuxuryCard>
    </button>
    <Dialog open={open} onOpenChange={(v) => { if (!v) setOpen(false); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-unsent-certificats">
        <DialogHeader>
          <DialogTitle>Certificats awaiting email</DialogTitle>
          <DialogDescription>These certificats de paiement do not have a successful client email on record. Send them here, or open the project for the full context.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {unsent.map((cert) => (
            <div key={cert.certificatId} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2" data-testid={`row-unsent-certificat-${cert.certificatId}`}>
              <div className="min-w-0">
                <ArchitectInvoiceBadge certId={cert.certificatId} />
                <Link href={`/projets/${cert.projectId}`} onClick={() => setOpen(false)}>
                  <p className="text-[11px] font-semibold text-foreground truncate underline-offset-2 hover:underline cursor-pointer">{cert.projectName} — {cert.certificateRef}{cert.isSolde ? " (solde)" : ""}</p>
                </Link>
                <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{cert.contractorName} · <Amount value={parseFloat(cert.netToPayTtc)} denomination="TTC" /></p>
                {cert.certificateStatus === "sent" && <p className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-300" data-testid={`label-false-sent-certificat-${cert.certificatId}`}>Marked sent · not emailed</p>}
              </div>
              <Button variant="outline" size="sm" className="h-7 px-2 text-[10px] shrink-0" disabled={sendMutation.isPending} onClick={() => sendMutation.mutate(cert)} data-testid={`button-send-unsent-certificat-${cert.certificatId}`}>Send</Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  </>;
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
