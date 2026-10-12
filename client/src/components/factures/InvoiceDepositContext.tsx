import { AlertTriangle, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency as fmt } from "@/lib/utils";
import type { useInvoiceReviewAmounts } from "./invoice-review-amounts";

type ReviewAmounts = ReturnType<typeof useInvoiceReviewAmounts>;

export function InvoiceDepositContext({ review, invoiceId, disabled }: {
  review: ReviewAmounts;
  invoiceId: number;
  disabled: boolean;
}) {
  const { deposit, heading, document } = review;
  if (!review.depositRequested) return null;
  const source = document.openingDepositSourceTotals ?? document;
  return (
    <section
      className={`rounded-lg border p-3 space-y-3 text-[12px] leading-relaxed ${deposit ? "border-[#c1a27b]/40 bg-[#c1a27b]/10" : "border-amber-300 bg-amber-50 text-amber-950"}`}
      aria-label="Requested deposit financial context"
      data-testid={`context-requested-deposit-${invoiceId}`}
    >
      <div className="flex items-start gap-2">
        {deposit ? <Receipt size={16} className="mt-0.5 shrink-0 text-[#0B2545]" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
        <div className="space-y-1">
          <p className="font-semibold">{deposit ? "Opening deposit request — not the full contract" : "Deposit request needs manual verification"}</p>
          <p>
            {heading ? <>The printed heading requests <strong>{heading.percentage}% of the full contract TTC</strong>: “{heading.text}”. </> : <>The document is identified as a deposit invoice. </>}
            This is a request for payment, <strong>not a deposit already paid</strong>. Confirming this invoice does not record a payment.
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 border-y border-[#c1a27b]/25 py-2 tabular-nums">
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Full contract reference — not this claim</dt>
          <dd className="font-medium">
            {source.amountHt != null && Number.isFinite(source.amountHt) ? `${fmt(source.amountHt)} HT` : "HT not available"}
            {" / "}
            {source.amountTtc != null && Number.isFinite(source.amountTtc) ? `${fmt(source.amountTtc)} TTC` : "TTC not available"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Requested deposit, including tax</dt>
          <dd className="font-semibold">
            {deposit ? `${fmt(deposit.amountTtc)} TTC` :
              document.netAPayer != null && Number.isFinite(document.netAPayer) ? `${fmt(document.netAPayer)} TTC printed as net payable — unverified` : "Not safely resolved"}
          </dd>
        </div>
      </dl>
      {deposit ? (
        <>
          <p>
            The document declares a single, verified <strong>{deposit.rate}% TVA rate</strong>.
            {" "}Requested TTC = {fmt(deposit.sourceTtc)} × {deposit.percentage}% = <strong>{fmt(deposit.amountTtc)}</strong>.
            {" "}Deposit HT = {fmt(deposit.amountTtc)} ÷ (1 + {deposit.rate}/100) = <strong>{fmt(deposit.amountHt)}</strong>.
            {" "}TVA = TTC − HT = {fmt(deposit.amountTtc)} − {fmt(deposit.amountHt)} = <strong>{fmt(deposit.tvaAmount)}</strong>.
            {" "}Amounts are rounded to the nearest cent.
          </p>
          {review.matchesDeposit ? (
            <p className="font-medium text-[#0B2545]" data-testid={`text-deposit-populated-${invoiceId}`}>
              The HT and TTC fields already contain the requested deposit amounts, not the full quotation totals. Review them against the source document before confirming.
            </p>
          ) : (
            <div className="space-y-2">
              <p>
                The current fields differ from the requested deposit. Older drafts may contain the full quotation totals, or these values may have been edited.
                Your values have been kept unchanged. Apply the verified deposit only if that is the claim you intend to confirm.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-[11px] h-auto min-h-8 whitespace-normal text-left"
                disabled={disabled}
                onClick={review.applyDeposit}
                data-testid={`button-apply-requested-deposit-${invoiceId}`}
              >
                Apply requested deposit amounts
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-1" data-testid={`warning-unresolved-deposit-${invoiceId}`}>
          <p>
            A deposit request was detected, but its percentage, full contract totals, net payable amount and declared TVA could not all be safely reconciled.
            No deposit amounts have been applied. Check the original document and enter both claim amounts manually; do not treat the full contract totals as the requested deposit.
          </p>
          <p>
            {review.declaredRates.length ? `Declared TVA in the document: ${review.declaredRates.map(rate => `${rate}%`).join(", ")}. ` : "No usable TVA rate was declared in the document. "}
            {review.rate != null ? `The ${review.rate}% rate is verified for editing HT/TTC, but the deposit itself remains unverified.` : "These declarations are not a verified single rate for automatic calculation."}
          </p>
        </div>
      )}
    </section>
  );
}

export function InvoiceAmountCalculationHint({ review, invoiceId }: {
  review: ReviewAmounts;
  invoiceId: number;
}) {
  return (
    <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground" aria-live="polite" data-testid={`text-draft-invoice-tva-derived-${invoiceId}`}>
      {review.rate == null ? (
        <p className="text-amber-800">
          {review.declaredRates.length ? `Declared document TVA: ${review.declaredRates.map(rate => `${rate}%`).join(", ")}. ` : ""}
          Manual review: no verified single document TVA rate is available. The rate may be missing, multiple rates may be declared,
          or the declared rate may not agree with the document totals (including special tax or charge treatment).
          HT and TTC are independent: check and enter both against the original document. No default or blended rate is assumed.
        </p>
      ) : (
        <p>
          Verified document TVA: <strong>{review.rate}%</strong>.
          {" "}{review.derivedField === "ht" ? `HT was derived from TTC ÷ (1 + ${review.rate}/100).` :
            review.derivedField === "ttc" ? `TTC was derived from HT × (1 + ${review.rate}/100).` :
            "Editing either amount recalculates the other using this rate; current values have not been overwritten."}
        </p>
      )}
      {review.validAmounts ? (
        <p>TVA = TTC − HT = {fmt(Number(review.amountTtc))} − {fmt(Number(review.amountHt))} = <strong>{fmt(review.tvaAmount!)}</strong>.</p>
      ) : (
        <p className="text-amber-800">Enter a valid, non-negative HT and TTC before confirming. A blank or invalid entry is not treated as zero; the other field is left unchanged.</p>
      )}
    </div>
  );
}
