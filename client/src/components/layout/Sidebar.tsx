import { useLocation, Link } from "wouter";
import {
  LayoutDashboard,
  FolderOpen,
  Building2,
  TrendingUp,
  FileCheck,
  Coins,
  Settings,
  HelpCircle,
  Bell,
  Search,
  Mail,
  MessageSquare,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import logoPath from "@assets/Generated_Image_February_28__2026_-_3_59PM.jpg-removebg-previe_1772291017667.png";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/projets", label: "Projects", icon: FolderOpen },
  { path: "/entreprises", label: "Contractors", icon: Building2 },
  { path: "/suivi-financier", label: "Financial Tracking", icon: TrendingUp },
  { path: "/certificats", label: "Certificats", icon: FileCheck },
  { path: "/honoraires", label: "Honoraires", icon: Coins },
  { path: "/documents", label: "Documents", icon: Mail },
  { path: "/communications", label: "Communications", icon: MessageSquare },
];

const bottomNavItems = [
  { path: "/settings", label: "Settings", icon: Settings },
];

const toolButtons = [
  { icon: Search, label: "Search", bg: "bg-rose-50 dark:bg-rose-950/30" },
  { icon: Bell, label: "Notifications", bg: "bg-amber-50 dark:bg-amber-950/30" },
  { icon: HelpCircle, label: "Help", bg: "bg-emerald-50 dark:bg-emerald-950/30" },
];

export function Sidebar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  const isActive = (path: string) => {
    if (path === "/") return location === "/";
    return location.startsWith(path);
  };

  return (
    <aside
      className="fixed left-0 top-0 h-screen w-64 flex flex-col z-50"
      style={{ backgroundColor: "#DFE1E2" }}
      data-testid="sidebar"
    >
      <div className="px-6 pt-6 pb-4">
        <Link href="/" data-testid="link-logo-home">
          <div className="cursor-pointer">
            <img
              src={logoPath}
              alt="ArchiTrak"
              className="h-28 w-auto object-contain"
              data-testid="img-logo"
            />
            <p className="text-[8px] font-black uppercase tracking-widest mt-1" style={{ color: "#7E7F83" }}>
              Financial Management
            </p>
          </div>
        </Link>
      </div>

      <nav className="flex-1 py-2" data-testid="nav-main">
        {navItems.map((item) => {
          const active = isActive(item.path);
          return (
            <Link key={item.path} href={item.path}>
              <div
                className={cn(
                  "flex items-center gap-3 px-6 py-2 cursor-pointer transition-colors relative",
                  active
                    ? "bg-white/70 border-r-[3px] border-r-red-500"
                    : "hover-elevate"
                )}
                data-testid={`link-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <item.icon
                  size={16}
                  strokeWidth={active ? 2 : 1.5}
                  className={cn(
                    active ? "text-[#0C0A09]" : "text-[#7E7F83]"
                  )}
                />
                <span
                  className={cn(
                    "text-[12px] uppercase tracking-wide",
                    active
                      ? "font-bold text-[#0C0A09]"
                      : "font-medium text-[#34312D]"
                  )}
                >
                  {item.label}
                </span>
              </div>
            </Link>
          );
        })}
      </nav>

      <div className="px-0 pb-2">
        {bottomNavItems.map((item) => {
          const active = isActive(item.path);
          return (
            <Link key={item.path} href={item.path}>
              <div
                className={cn(
                  "flex items-center gap-3 px-6 py-2 cursor-pointer transition-colors relative",
                  active
                    ? "bg-white/70 border-r-[3px] border-r-red-500"
                    : "hover-elevate"
                )}
                data-testid={`link-nav-${item.label.toLowerCase()}`}
              >
                <item.icon
                  size={16}
                  strokeWidth={active ? 2 : 1.5}
                  className={cn(active ? "text-[#0C0A09]" : "text-[#7E7F83]")}
                />
                <span
                  className={cn(
                    "text-[12px] uppercase tracking-wide",
                    active ? "font-bold text-[#0C0A09]" : "font-medium text-[#34312D]"
                  )}
                >
                  {item.label}
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="px-4 pb-4">
        <div className="grid grid-cols-3 gap-2" data-testid="nav-tools">
          {toolButtons.map((tool) => (
            <Tooltip key={tool.label}>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "flex items-center justify-center p-2 rounded-xl transition-colors",
                    tool.bg
                  )}
                  data-testid={`button-tool-${tool.label.toLowerCase()}`}
                >
                  <tool.icon size={14} strokeWidth={1.5} className="text-[#34312D]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="text-xs">{tool.label}</span>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>

      {user && (
        <div className="px-4 pb-4 border-t border-black/5 pt-3" data-testid="sidebar-user">
          <div className="flex items-center gap-2.5">
            {user.profileImageUrl ? (
              <img
                src={user.profileImageUrl}
                alt=""
                className="w-7 h-7 rounded-full object-cover flex-shrink-0"
                data-testid="img-user-avatar"
              />
            ) : (
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                style={{ backgroundColor: "#0B2545" }}
              >
                {(user.firstName?.[0] || user.email[0]).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-[#34312D] truncate" data-testid="text-user-name">
                {user.firstName && user.lastName
                  ? `${user.firstName} ${user.lastName}`
                  : user.email}
              </p>
              <p className="text-[9px] text-[#7E7F83] truncate" data-testid="text-user-email">
                {user.email}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={logout}
                  className="p-1.5 rounded-lg hover:bg-black/5 transition-colors flex-shrink-0"
                  data-testid="button-logout"
                >
                  <LogOut size={13} strokeWidth={1.5} className="text-[#7E7F83]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="text-xs">Sign out</span>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
    </aside>
  );
}
