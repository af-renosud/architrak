/**
 * <Amount> — canonical way to render a euro figure in JSX.
 *
 * The `denomination` prop is REQUIRED so every rendered amount is labelled:
 *   <Amount value={total} denomination="TTC" />   → "1 234,56 € TTC"
 *   <Amount value={ht}    denomination="HT" />    → "1 234,56 € HT"
 *   <Amount value={tva}   denomination="TVA" />   → "   246,91 € TVA"
 *   <Amount value={n}     denomination="none" />  → "1 234,56 €"  (no suffix)
 *
 * Use `denomination="none"` only for genuinely denomination-free figures
 * (e.g. a standalone "paid amount" in a context that already carries the
 * label elsewhere).  Every other case must carry HT, TTC, TVA, RG, etc.
 *
 * In non-JSX contexts (toast messages, template strings) use the bare
 * `formatCurrency` exported from `@/lib/utils` directly.
 */
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";

export type Denomination = "HT" | "TTC" | "TVA" | "RG" | "PV" | "MV" | "none" | (string & {});

interface AmountProps {
  /** Numeric euro value to format. */
  value: number;
  /**
   * Denomination label shown after the figure.
   * Pass "none" only when the surrounding context already provides the label.
   */
  denomination: Denomination;
  className?: string;
  /** Extra class applied to the denomination <span> only. */
  denominationClassName?: string;
}

export function Amount({ value, denomination, className, denominationClassName }: AmountProps) {
  const formatted = formatCurrency(value);
  if (denomination === "none") {
    return <span className={className}>{formatted}</span>;
  }
  return (
    <span className={cn("inline-flex items-baseline gap-1", className)}>
      {formatted}
      <span className={cn("text-[0.85em] text-muted-foreground", denominationClassName)}>
        {denomination}
      </span>
    </span>
  );
}
