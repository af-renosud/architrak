import type { QuotationIssue } from "@shared/quotation-decision";

/** These evidence gaps can be resolved by an independently confirmed source.
 * Missing/unreadable or changed PDF bytes cannot be repaired by typing a total. */
export function needsSourceConfirmation(code?: string): boolean {
  return ["FIGURES_UNAVAILABLE", "SOURCE_CONFIRMATION_REQUIRED", "DESCRIPTION_CHARGE_UNVERIFIED", "COVERAGE_INCOMPLETE",
    "SOURCE_RECEIPT_OUTDATED", "SOURCE_ROWS_CHANGED", "SOURCE_INVENTORY_CHANGED",
    "PAGES_NOT_EXTRACTED", "PAGE_ITEMS_MISSING"].includes(code ?? "");
}

/** Explicit API vocabulary aliases, never derived from a translated message. */
export function quotationEditorField(field?: string, header = false): string | undefined {
  if (!field) return undefined;
  const aliases: Record<string, string> = {
    description: "descriptionFr", translation: "descriptionEn",
    unitPrice: "unitPriceHt", total: "totalHt", totalPrice: "totalHt",
    tvaRate: "vatRate", source_ttc: "sourceTtc", baseline: "sourceTtc",
    descriptionExplanation: "explanationEn", summary: "summaryEn",
    document: "context",
  };
  const resolved = aliases[field] ?? field;
  if (header && resolved === "descriptionFr") return "headerFr";
  if (header && resolved === "descriptionEn") return "headerEn";
  return resolved;
}

export function quotationTargetRowId(key: string, target?: QuotationIssue["target"]): number | undefined {
  if (target?.rowId != null) return target.rowId;
  // Compatibility with older readiness responses: stable keys, not prose.
  const match = key.match(/^(?:line|row)-(\d+)$/);
  return match ? Number(match[1]) : undefined;
}
