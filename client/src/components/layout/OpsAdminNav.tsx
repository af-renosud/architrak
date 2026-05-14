import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const OPS_NAV_ITEMS = [
  { path: "/admin/ops/webhook-dlq", label: "Webhook DLQ" },
  { path: "/admin/ops/mirror-restore", label: "Mirror restore" },
  { path: "/admin/ops/transient-failures", label: "Transient failures" },
  { path: "/admin/ops/drive-uploads", label: "Drive auto-upload" },
  { path: "/admin/ops/signed-pdf-recovery", label: "Signed PDF recovery" },
] as const;

interface DriveStatusResponse {
  enabled: boolean;
}

export function OpsAdminNav() {
  const [location] = useLocation();

  const driveStatus = useQuery<DriveStatusResponse>({
    queryKey: ["/api/admin/drive-uploads", "all"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/drive-uploads`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  return (
    <nav
      className="flex flex-wrap items-center gap-1 border-b pb-3"
      data-testid="nav-ops-admin"
      aria-label="Operator admin"
    >
      {OPS_NAV_ITEMS.map((item) => {
        const active = location === item.path;
        const isDrive = item.path === "/admin/ops/drive-uploads";
        const showDisabledBadge =
          isDrive && driveStatus.data && !driveStatus.data.enabled;
        return (
          <Link key={item.path} href={item.path}>
            <div
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                active
                  ? "bg-foreground text-background font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              data-testid={`link-ops-${item.path.split("/").pop()}`}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
              {showDisabledBadge && (
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    active
                      ? "bg-background/20 text-background"
                      : "bg-amber-100 text-amber-900",
                  )}
                  data-testid="badge-ops-drive-disabled"
                  title="Set DRIVE_AUTO_UPLOAD_ENABLED=true to enable"
                >
                  Off
                </span>
              )}
            </div>
          </Link>
        );
      })}
    </nav>
  );
}
