/** Presentation only. Navigation and API requests retain their original field keys. */
export function quotationFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    descriptionFr: "French description", descriptionEn: "English translation",
    explanationFr: "French explanation", explanationEn: "English explanation",
    headerFr: "French header", headerEn: "English header", summaryEn: "English overview",
    quantity: "Quantity", unit: "Unit", unitPriceHt: "Unit price excluding VAT",
    totalHt: "Total excluding VAT", vatRate: "VAT rate", discountHt: "Discount excluding VAT",
    sourceTtc: "Original PDF total including VAT", source_ttc: "Original PDF total including VAT",
    ttc: "Total including VAT", ht: "Total excluding VAT", vat: "VAT",
    sourceText: "Original PDF text", priceText: "Original PDF price",
    lineNumber: "Item number", sourcePage: "Original PDF page",
  };
  return labels[field] ?? field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, text => text.toUpperCase());
}
