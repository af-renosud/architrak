import { cn } from "@/lib/utils";

interface TechnicalLabelProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
}

export function TechnicalLabel({ className, children, ...props }: TechnicalLabelProps) {
  return (
    <span
      className={cn(
        "text-[9px] font-black uppercase tracking-[0.2em]",
        "text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
