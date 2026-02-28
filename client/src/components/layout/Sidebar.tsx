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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const navItems = [
  { path: "/", label: "Tableau de Bord", icon: LayoutDashboard },
  { path: "/projets", label: "Projets", icon: FolderOpen },
  { path: "/entreprises", label: "Entreprises", icon: Building2 },
  { path: "/suivi-financier", label: "Suivi Financier", icon: TrendingUp },
  { path: "/certificats", label: "Certificats", icon: FileCheck },
  { path: "/honoraires", label: "Honoraires", icon: Coins },
];

const toolButtons = [
  { icon: Search, label: "Rechercher", bg: "bg-rose-50 dark:bg-rose-950/30" },
  { icon: Bell, label: "Notifications", bg: "bg-amber-50 dark:bg-amber-950/30" },
  { icon: Settings, label: "Paramètres", bg: "bg-purple-50 dark:bg-purple-950/30" },
  { icon: HelpCircle, label: "Aide", bg: "bg-emerald-50 dark:bg-emerald-950/30" },
];

export function Sidebar() {
  const [location] = useLocation();

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
        <h1
          className="text-[20px] font-light uppercase tracking-tight"
          style={{ color: "#0B2545" }}
          data-testid="text-branding"
        >
          ArchiTrak
        </h1>
        <p className="text-[8px] font-black uppercase tracking-widest mt-1" style={{ color: "#7E7F83" }}>
          Gestion Financière
        </p>
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

      <div className="px-4 pb-6">
        <div className="grid grid-cols-4 gap-2" data-testid="nav-tools">
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
    </aside>
  );
}
