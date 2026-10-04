import { createHash } from "node:crypto";

/** Stable across object key order and JSON/date round-trips. Include complete
 * records, not only money or descriptions: review and translation edits matter. */
export function stableQuotationDigest(value: unknown) {
  const stable = (value: any): any => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function quotationWorkingVersion(quotation: unknown, lines: unknown[], translation: unknown) {
  return stableQuotationDigest({ quotation, lines, translation: translation ?? null });
}