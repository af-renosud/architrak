import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import type { InboxContractorResponseRow } from "@shared/schema";

type InboxResponse = {
  count: number;
  items: InboxContractorResponseRow[];
};

function truncate(s: string | null, max = 110): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatRelative(d: string | Date | null): string {
  if (!d) return "";
  try {
    return formatDistanceToNow(typeof d === "string" ? new Date(d) : d, {
      addSuffix: true,
      locale: fr,
    });
  } catch {
    return "";
  }
}

export function NotificationBell() {
  const [, navigate] = useLocation();
  const { data } = useQuery<InboxResponse>({
    queryKey: ["/api/notifications/contractor-responses"],
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const items = data?.items ?? [];
  const count = data?.count ?? 0;
  const hasUnread = count > 0;
  const badgeLabel = count > 99 ? "99+" : String(count);

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className={cn(
                "relative flex items-center justify-center p-2 rounded-xl transition-colors",
                "bg-amber-50 dark:bg-amber-950/30",
              )}
              data-testid="button-tool-notifications"
              aria-label={
                hasUnread
                  ? `Notifications (${count} non lues)`
                  : "Notifications"
              }
            >
              <Bell size={14} strokeWidth={1.5} className="text-[#34312D]" />
              {hasUnread && (
                <span
                  className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center leading-none"
                  data-testid="badge-notifications-count"
                >
                  {badgeLabel}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="text-xs">Notifications</span>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="right"
        align="end"
        className="w-[360px] p-0"
        data-testid="popover-notifications"
      >
        <div className="px-4 py-3 border-b">
          <p className="text-[11px] font-bold uppercase tracking-wide text-[#34312D]">
            Réponses des entrepreneurs
          </p>
          <p className="text-[10px] text-[#7E7F83] mt-0.5">
            {hasUnread
              ? `${count} en attente de votre réponse`
              : "Aucune nouvelle réponse"}
          </p>
        </div>

        <div className="max-h-[420px] overflow-y-auto">
          {items.length === 0 ? (
            <div
              className="px-4 py-6 text-center text-[11px] text-[#7E7F83]"
              data-testid="text-notifications-empty"
            >
              Tout est à jour.
            </div>
          ) : (
            <ul className="divide-y" data-testid="list-notifications">
              {items.map((item) => (
                <li key={item.checkId}>
                  <button
                    onClick={() =>
                      navigate(
                        `/projets/${item.projectId}?devis=${item.devisId}&check=${item.checkId}`,
                      )
                    }
                    className="w-full text-left px-4 py-3 hover:bg-black/5 transition-colors"
                    data-testid={`button-notification-${item.checkId}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <p
                        className="text-[11px] font-semibold text-[#0C0A09] truncate"
                        data-testid={`text-notification-contractor-${item.checkId}`}
                      >
                        {item.contractorName ?? "Entrepreneur"}
                      </p>
                      <span className="text-[9px] text-[#7E7F83] whitespace-nowrap">
                        {formatRelative(item.latestMessageAt ?? item.checkUpdatedAt)}
                      </span>
                    </div>
                    <p className="text-[10px] text-[#7E7F83] mt-0.5 truncate">
                      {item.projectName}
                      {item.devisCode ? ` · ${item.devisCode}` : ""}
                    </p>
                    <p
                      className="text-[11px] text-[#34312D] mt-1.5 line-clamp-2"
                      data-testid={`text-notification-body-${item.checkId}`}
                    >
                      {truncate(item.latestMessageBody) || truncate(item.checkQuery)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
