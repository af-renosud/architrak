import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { LucideIcon } from "lucide-react";
// These primitives retain the main app's actual class strings.
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function formatCurrency(value: number) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}
export function Amount({ value, denomination, className, denominationClassName }: { value: number; denomination: string; className?: string; denominationClassName?: string }) {
  const formatted = formatCurrency(value);
  if (denomination === "none") return <span className={className}>{formatted}</span>;
  return <span className={cn("inline-flex items-baseline gap-1", className)}>
    {formatted}<span className={cn("text-[0.85em] text-muted-foreground", denominationClassName)}>{denomination}</span>
  </span>;
}
export function LuxuryCard({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(
    "bg-card rounded-[2rem] p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]",
    "border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]", className,
  )} {...props}>{children}</div>;
}
export function TechnicalLabel({ className, children, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("text-[9px] font-black uppercase tracking-[0.2em]", "text-muted-foreground", className)} {...props}>{children}</span>;
}
export function SectionHeader({ icon: Icon, title, subtitle, className, actions }: { icon: LucideIcon; title: string; subtitle?: string; className?: string; actions?: React.ReactNode }) {
  return <div className={cn("flex items-center justify-between gap-4 flex-wrap", className)}>
    <div className="flex items-center gap-4">
      <div className="p-3 rounded-2xl shadow-lg" style={{ background: "linear-gradient(135deg, #0B2545 0%, #163a64 100%)" }}>
        <Icon size={20} strokeWidth={1.5} className="text-white" />
      </div>
      <div><h2 className="text-[14px] font-black uppercase tracking-tight text-foreground">{title}</h2>
        {subtitle && <p className="text-[9px] font-black uppercase tracking-widest mt-0.5" style={{ color: "#7E7F83" }}>{subtitle}</p>}
      </div>
    </div>
    {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
  </div>;
}
// Dashboard source only uses active/completed project states.
const statuses: Record<string, { label: string; bg: string; text: string; border: string }> = {
  active: { label: "ACTIVE", bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-800" },
  completed: { label: "COMPLETED", bg: "bg-blue-50 dark:bg-blue-950/40", text: "text-blue-700 dark:text-blue-400", border: "border-blue-200 dark:border-blue-800" },
};
export function StatusBadge({ status, className, size = "md" }: { status: string; className?: string; size?: "sm" | "md" }) {
  const config = statuses[status] || { label: status.toUpperCase(), bg: "bg-slate-50 dark:bg-slate-900/40", text: "text-slate-600 dark:text-slate-400", border: "border-slate-200 dark:border-slate-700" };
  return <span className={cn("inline-flex items-center rounded-md border", "font-black uppercase tracking-widest whitespace-nowrap", size === "sm" ? "px-1.5 py-0 text-[7px]" : "px-2 py-0.5 text-[8px]", config.bg, config.text, config.border, className)} data-testid={`status-badge-${status}`}>{config.label}</span>;
}
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0" +
  " hover-elevate active-elevate-2",
  { variants: {
    variant: {
      default: "bg-primary text-primary-foreground border border-primary-border",
      destructive: "bg-destructive text-destructive-foreground border border-destructive-border",
      outline: " border [border-color:var(--button-outline)]  shadow-xs active:shadow-none ",
      secondary: "border bg-secondary text-secondary-foreground border border-secondary-border ",
      ghost: "border border-transparent",
    },
    size: { default: "min-h-9 px-4 py-2", sm: "min-h-8 rounded-md px-3 text-xs", lg: "min-h-10 rounded-md px-8", icon: "h-9 w-9" },
  }, defaultVariants: { variant: "default", size: "default" } },
);
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = "Button";
export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, type, ...props }, ref) => (
  <input type={type} className={cn("flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm", className)} ref={ref} {...props} />
));
Input.displayName = "Input";
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
