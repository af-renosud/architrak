import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Clock, ShieldCheck } from "lucide-react";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
}

export type AccountingStatusValue = "clean" | "pending_analysis" | "needs_review" | "resolved";

interface AccountingStatusBadgeProps {
  status: AccountingStatusValue;
  eurosAtRisk?: number;
  needsReviewCount?: number;
  className?: string;
}

const config: Record<AccountingStatusValue, { label: string; bg: string; text: string; border: string; Icon: typeof AlertTriangle }> = {
  clean: {
    label: "No anomalies",
    bg: "bg-emerald-50 dark:bg-emerald-950/40",
    text: "text-emerald-700 dark:text-emerald-400",
    border: "border-emerald-200 dark:border-emerald-800",
    Icon: CheckCircle2,
  },
  pending_analysis: {
    label: "Analysing",
    bg: "bg-slate-50 dark:bg-slate-900/40",
    text: "text-slate-600 dark:text-slate-400",
    border: "border-slate-200 dark:border-slate-700",
    Icon: Clock,
  },
  needs_review: {
    label: "Needs review",
    bg: "bg-amber-50 dark:bg-amber-950/40",
    text: "text-amber-700 dark:text-amber-400",
    border: "border-amber-200 dark:border-amber-800",
    Icon: AlertTriangle,
  },
  resolved: {
    label: "Resolved",
    bg: "bg-blue-50 dark:bg-blue-950/40",
    text: "text-blue-700 dark:text-blue-400",
    border: "border-blue-200 dark:border-blue-800",
    Icon: ShieldCheck,
  },
};

/**
 * Quiet per-project accounting-anomaly status indicator. Surfaces the
 * Task #232 accounting rollup (clean / analysing / needs review + euros at
 * risk / resolved) so the architect knows at a glance whether anything needs
 * them, without shouting at them when everything is fine.
 */
export function AccountingStatusBadge({ status, eurosAtRisk = 0, needsReviewCount = 0, className }: AccountingStatusBadgeProps) {
  const c = config[status];
  const { Icon } = c;
  const showEuros = status === "needs_review" && eurosAtRisk > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.15em]",
        c.bg,
        c.text,
        c.border,
        className,
      )}
      data-testid="badge-accounting-status"
    >
      <Icon size={11} strokeWidth={2} />
      <span>
        {c.label}
        {status === "needs_review" && needsReviewCount > 0 && ` (${needsReviewCount})`}
      </span>
      {showEuros && (
        <span className="font-bold normal-case tracking-normal opacity-90" data-testid="text-accounting-euros-at-risk">
          {formatCurrency(eurosAtRisk)} at risk
        </span>
      )}
    </span>
  );
}
