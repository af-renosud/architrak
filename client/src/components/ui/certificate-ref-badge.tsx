import { cn } from "@/lib/utils";

interface CertificateRefBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
}

/** Pill badge for certificate refs (C1, C2 …). Navy-filled, dark-mode aware. */
export function CertificateRefBadge({ className, children, ...props }: CertificateRefBadgeProps) {
  return (
    <span
      className={cn(
        "inline-block px-2.5 py-0.5 rounded-full",
        "text-[13px] font-bold leading-snug",
        "bg-[#0B2545] text-white",
        "dark:bg-[#0B2545]/80 dark:text-slate-100",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
