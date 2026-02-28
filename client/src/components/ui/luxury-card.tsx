import { cn } from "@/lib/utils";

interface LuxuryCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function LuxuryCard({ className, children, ...props }: LuxuryCardProps) {
  return (
    <div
      className={cn(
        "bg-card rounded-[2rem] p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]",
        "border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
