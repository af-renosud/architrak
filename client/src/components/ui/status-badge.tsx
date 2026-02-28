import { cn } from "@/lib/utils";

type StatusType =
  | "draft"
  | "active"
  | "completed"
  | "archived"
  | "pending"
  | "live"
  | "void"
  | "approved"
  | "rejected"
  | "sent"
  | "paid"
  | "overdue"
  | "submitted"
  | "certified"
  | "ready"
  | "partial"
  | "invoiced";

const statusConfig: Record<StatusType, { label: string; bg: string; text: string; border: string }> = {
  draft: { label: "BROUILLON", bg: "bg-slate-50 dark:bg-slate-900/40", text: "text-slate-600 dark:text-slate-400", border: "border-slate-200 dark:border-slate-700" },
  active: { label: "EN COURS", bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-800" },
  completed: { label: "TERMINÉ", bg: "bg-blue-50 dark:bg-blue-950/40", text: "text-blue-700 dark:text-blue-400", border: "border-blue-200 dark:border-blue-800" },
  archived: { label: "ARCHIVÉ", bg: "bg-gray-50 dark:bg-gray-900/40", text: "text-gray-600 dark:text-gray-400", border: "border-gray-200 dark:border-gray-700" },
  pending: { label: "EN ATTENTE", bg: "bg-amber-50 dark:bg-amber-950/40", text: "text-amber-700 dark:text-amber-400", border: "border-amber-200 dark:border-amber-800" },
  live: { label: "LIVE", bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-800" },
  void: { label: "VOID", bg: "bg-red-50 dark:bg-red-950/40", text: "text-red-700 dark:text-red-400", border: "border-red-200 dark:border-red-800" },
  approved: { label: "APPROUVÉ", bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-800" },
  rejected: { label: "REJETÉ", bg: "bg-red-50 dark:bg-red-950/40", text: "text-red-700 dark:text-red-400", border: "border-red-200 dark:border-red-800" },
  sent: { label: "ENVOYÉ", bg: "bg-blue-50 dark:bg-blue-950/40", text: "text-blue-700 dark:text-blue-400", border: "border-blue-200 dark:border-blue-800" },
  paid: { label: "PAYÉ", bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-800" },
  overdue: { label: "EN RETARD", bg: "bg-red-50 dark:bg-red-950/40", text: "text-red-700 dark:text-red-400", border: "border-red-200 dark:border-red-800" },
  submitted: { label: "SOUMIS", bg: "bg-blue-50 dark:bg-blue-950/40", text: "text-blue-700 dark:text-blue-400", border: "border-blue-200 dark:border-blue-800" },
  certified: { label: "CERTIFIÉ", bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-800" },
  ready: { label: "PRÊT", bg: "bg-amber-50 dark:bg-amber-950/40", text: "text-amber-700 dark:text-amber-400", border: "border-amber-200 dark:border-amber-800" },
  partial: { label: "PARTIEL", bg: "bg-amber-50 dark:bg-amber-950/40", text: "text-amber-700 dark:text-amber-400", border: "border-amber-200 dark:border-amber-800" },
  invoiced: { label: "FACTURÉ", bg: "bg-blue-50 dark:bg-blue-950/40", text: "text-blue-700 dark:text-blue-400", border: "border-blue-200 dark:border-blue-800" },
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status as StatusType] || {
    label: status.toUpperCase(),
    bg: "bg-slate-50 dark:bg-slate-900/40",
    text: "text-slate-600 dark:text-slate-400",
    border: "border-slate-200 dark:border-slate-700",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md border",
        "text-[8px] font-black uppercase tracking-widest whitespace-nowrap",
        config.bg,
        config.text,
        config.border,
        className
      )}
      data-testid={`status-badge-${status}`}
    >
      {config.label}
    </span>
  );
}
