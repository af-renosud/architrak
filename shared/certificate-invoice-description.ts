import { formatCurrencyNoSymbol } from "./financial-utils";

export interface CertificateInvoiceDescriptionInput {
  certificateRef: string | null;
  contractorName: string | null;
  netToPayHt: string | number | null;
  quotations: Array<{ lotNumber: string | null; title: string | null }>;
  invoiceNumbers: Array<string | null>;
  openingDeposit: boolean;
}

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/** Pure, reusable accounting description; never calculates an architect fee. */
export function buildCertificateInvoiceDescription(input: CertificateInvoiceDescriptionInput): string {
  const quotes = input.quotations.length ? input.quotations : [{ lotNumber: null, title: null }];
  const works = Array.from(new Set(quotes.map(q =>
    `Lot ${clean(q.lotNumber) || "(reference unavailable)"} — ${clean(q.title) || "(quotation title unavailable)"}`
  ))).join("; ");
  const numbers = Array.from(new Set(input.invoiceNumbers.map(n => clean(n) || "(invoice number unavailable)")));
  const invoices = numbers.length
    ? `Contractor invoice(s): ${numbers.join(", ")}.`
    : input.openingDeposit
      ? "Opening Deposit - No accompanying contractor invoice."
      : "Contractor invoice references unavailable.";
  const amount = input.netToPayHt == null || String(input.netToPayHt).trim() === "" ? NaN : Number(input.netToPayHt);
  const ht = Number.isFinite(amount) ? `${formatCurrencyNoSymbol(amount)} HT` : "(amount unavailable)";
  return `Certificate ${clean(input.certificateRef) || "(reference unavailable)"} — ${clean(input.contractorName) || "(company name unavailable)"} — ${works}. ${invoices} Certificate net payable this period: ${ht}.`;
}
