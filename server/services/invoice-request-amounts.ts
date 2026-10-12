import type { ParsedDocument } from "../gmail/document-parser";
import { resolveOpeningDeposit } from "../../shared/invoice-deposit";

/** Separate financial invoice amounts from unmodified full-contract extraction evidence. */
export function invoiceRequestAmounts(parsed: ParsedDocument) {
  const deposit = resolveOpeningDeposit(parsed);
  if (!deposit) return { amountHt: parsed.amountHt, amountTtc: parsed.amountTtc };
  if (deposit.sourceHt != null && !parsed.openingDepositSourceTotals) {
    parsed.openingDepositSourceTotals = {
      amountHt: deposit.sourceHt,
      amountTtc: deposit.sourceTtc,
      tvaAmount: parsed.tvaAmount,
    };
  }
  return { amountHt: deposit.amountHt, amountTtc: deposit.amountTtc };
}
