import type { Devis, DevisLineItem } from "@shared/schema";

/** Only an immutable, source-bound carry-forward audit can explain why
 * working wording differs from the verified extraction. Never relax money,
 * row identity or any subsequent edit checks. */
export function sourceRowsForCarriedWording(
  quotation: Devis, lines: DevisLineItem[], audits: unknown[] = [],
): DevisLineItem[] {
  const evidence = quotation.aiExtractedData as any;
  const digest = evidence?.pricedItemVerification?.sourceDigest ?? evidence?.quotationVerification?.sourceDigest;
  if (!digest) return lines;
  return lines.map(line => {
    for (const raw of audits) {
      const audit = raw as any;
      if (audit?.kind !== "carry_forward" || audit.targetSourceKey !== quotation.pdfStorageKey
        || audit.targetSourceDigest !== digest || !Array.isArray(audit.wordingTransfers)) continue;
      const transfer = audit.wordingTransfers.find((entry: any) => entry?.before?.id === line.id
        && entry.afterDescription === line.description);
      const before = transfer?.before;
      if (!before || before.devisId !== line.devisId || before.lineNumber !== line.lineNumber
        || ["quantity", "unitPriceHt", "totalHt"].some(key => String(before[key]) !== String((line as any)[key]))
        || before.unit !== line.unit) continue;
      return { ...line, description: before.description };
    }
    return line;
  });
}
