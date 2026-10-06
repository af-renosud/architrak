import { formatCurrencyNoSymbol } from "./financial-utils";

export interface CertificateInvoiceDescriptionInput {
  certificateRef: string | null;
  contractorName: string | null;
  netToPayHt: string | number | null;
  quotations: Array<{ lotNumber: string | null; title: string | null; managementPercentage?: string | number | null }>;
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
  const rates = quotes.map(q => {
    const value = q.managementPercentage;
    const rate = value == null || String(value).trim() === "" ? NaN : Number(value);
    return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? `${rate}%` : "(rate unavailable)";
  });
  const fee = new Set(rates).size === 1
    ? rates[0]
    : Array.from(new Set(quotes.map((q, i) =>
      `Lot ${clean(q.lotNumber) || "(reference unavailable)"} — ${clean(q.title) || "(quotation title unavailable)"}: ${rates[i]}`
    ))).join("; ");
  return `Certificate ${clean(input.certificateRef) || "(reference unavailable)"} — ${clean(input.contractorName) || "(company name unavailable)"} — ${works}. ${invoices} Certificate net payable this period: ${ht}. Project management fee: ${fee}.`;
}
