import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OutstandingFeeSummary } from "@shared/fee-description";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

interface Props {
  scope: "global" | "project";
  projectId?: number;
  /** Where the "View" button navigates. */
  href: string;
  /** When set, the banner is dismissible per session and the key namespaces the dismissal. */
  dismissKey?: string;
  /** Optional click handler for the View button (e.g., switch tabs in-place). */
  onView?: () => void;
}

export function OutstandingFeesBanner({ scope, projectId, href, dismissKey, onView }: Props) {
  const queryKey = scope === "global"
    ? ["/api/fees/outstanding"]
    : ["/api/projects", projectId !== undefined ? String(projectId) : "", "fees", "outstanding"];

  const { data } = useQuery<OutstandingFeeSummary>({
    queryKey,
    enabled: scope === "global" || (projectId !== undefined && projectId > 0),
    refetchInterval: 60_000,
  });

  const storageKey = dismissKey ? `architrak:dismissed-outstanding-banner:${dismissKey}` : null;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!storageKey) return;
    try {
      setDismissed(sessionStorage.getItem(storageKey) === "1");
    } catch {
      // sessionStorage unavailable — keep visible
    }
  }, [storageKey]);

  if (!data || data.totalCount === 0 || dismissed) return null;

  return (
    <div
      className="rounded-xl border border-amber-300 bg-amber-50/80 dark:border-amber-800 dark:bg-amber-950/30 px-3 py-2 flex items-center gap-3 flex-wrap"
      data-testid={`banner-outstanding-fees-${scope}`}
    >
      <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 shrink-0" />
      <div className="flex-1 min-w-0 text-[12px] text-foreground">
        <span className="font-semibold" data-testid="text-banner-outstanding-count">
          {data.totalCount} outstanding architect fee{data.totalCount === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground">
          {" "}· total {" "}
          <span className="font-semibold text-foreground" data-testid="text-banner-outstanding-total">
            {formatCurrency(data.totalFeeHt)} HT
          </span>
        </span>
      </div>
      <Link href={href}>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 border-amber-400 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
          onClick={onView}
          data-testid={`button-banner-view-${scope}`}
        >
          <span className="text-[10px] font-bold uppercase tracking-widest">View</span>
        </Button>
      </Link>
      {storageKey && (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => {
            try {
              sessionStorage.setItem(storageKey, "1");
            } catch {
              // ignore
            }
            setDismissed(true);
          }}
          data-testid={`button-banner-dismiss-${scope}`}
          title="Hide for this session"
        >
          <X size={12} />
        </Button>
      )}
    </div>
  );
}
