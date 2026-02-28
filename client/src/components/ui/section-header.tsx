import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface SectionHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  className?: string;
  actions?: React.ReactNode;
}

export function SectionHeader({ icon: Icon, title, subtitle, className, actions }: SectionHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between gap-4 flex-wrap", className)}>
      <div className="flex items-center gap-4">
        <div
          className="p-3 rounded-2xl shadow-lg"
          style={{
            background: "linear-gradient(135deg, #0B2545 0%, #163a64 100%)",
          }}
        >
          <Icon size={20} strokeWidth={1.5} className="text-white" />
        </div>
        <div>
          <h2 className="text-[14px] font-black uppercase tracking-tight text-foreground">
            {title}
          </h2>
          {subtitle && (
            <p className="text-[9px] font-black uppercase tracking-widest mt-0.5" style={{ color: "#7E7F83" }}>
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}
