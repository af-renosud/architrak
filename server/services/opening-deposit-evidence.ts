import type { ParsedDocument } from "../gmail/document-parser";
import { roundCurrency } from "../../shared/financial-utils";

/** A deposit request is not a previously paid deposit or a deduction.
 * Require a printed invoice heading, an explicit TTC percentage and matching
 * arithmetic; classification alone must never suppress a genuine discrepancy.
 */
export function openingDepositEvidence(text: string) {
  const match = text.match(/(?:^|\n)\s*(FACTURE\s+D['’ʼ` ]ACOMPTE\s+(?:DE\s+)?(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:DU\s+TOTAL\s+)?T[.\s]*T[.\s]*C[.]?)(?=\s|$)/i);
  if (!match) return null;
  const context = text.slice(match.index! + match[0].length, match.index! + match[0].length + 160)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(?:paye|payee|regle|reglee|deduit|deduite|deduction|verse|versee)\b/.test(context)) return null;
  const percentage = Number(match[2].replace(",", "."));
  if (!(percentage > 0 && percentage < 100)) return null;
  return { percentage, text: match[1] };
}

export function isVerifiedOpeningDeposit(parsed: ParsedDocument): boolean {
  if (!["invoice", "acompte"].includes(parsed.documentType)) return false;
  const ttc = parsed.amountTtc;
  const net = parsed.netAPayer;
  if (ttc == null || net == null || !Number.isFinite(ttc) || !Number.isFinite(net) || !(net > 0 && net < ttc)) return false;
  if ((parsed.retenueDeGarantie ?? 0) !== 0 || (parsed.acomptePaidAmountTtc ?? 0) !== 0) return false;
  // Prefer the independently extracted PDF text. Legacy extractions may retain
  // the same verbatim heading in rawText / acompteTrigger.
  const evidence = openingDepositEvidence(parsed.openingDepositEvidenceText ?? "")
    ?? openingDepositEvidence(parsed.rawText ?? "")
    ?? openingDepositEvidence(parsed.acompteTrigger ?? "");
  return !!evidence && Math.abs(roundCurrency(ttc * evidence.percentage / 100) - roundCurrency(net)) < 0.011;
}
