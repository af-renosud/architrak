import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Shared currency formatter (French locale, EUR).
 * Prefer the <Amount> component in JSX — it enforces a denomination label
 * (HT / TTC / TVA / …) at the call site.  Use this bare function only in
 * non-JSX contexts (toast messages, template strings, data transforms).
 */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}
