import { createHash } from "node:crypto";
import type { DevisLineItem } from "@shared/schema";
import type { ParsedDocument } from "../../../gmail/document-parser";
import type { ArchitectCorrectionDraft } from "../../../../shared/architect-quotation";
import { PRICED_EVIDENCE_PARSER, pricedRowsDigest } from "../../quotation-priced-evidence";

// Synthetic fixtures only. These represent failure shapes, not client records.
export const sourceBytes = Buffer.from("synthetic quotation source v1");
export const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
export function workingRow(id: number, description: string, total = "100.00"): DevisLineItem {
  return { id, devisId: 901, lineNumber: id, description, quantity: "1.000", unit: "u",
    unitPriceHt: total, totalHt: total, percentComplete: "0.00", checkStatus: "unchecked",
    checkNotes: null, pdfPageHint: 1, pdfBbox: null };
}
export function cleanImport(rows = [workingRow(1, "Roof repair")]): ParsedDocument {
  const items = rows.map(row => ({ description: row.description, total: Number(row.totalHt), quantity: 1, unitPrice: Number(row.totalHt) }));
  const ht = items.reduce((sum, row) => sum + row.total, 0);
  return { documentType: "quotation", lineItems: items, amountHt: ht, amountTtc: ht * 1.2,
    nativeTableRecovery: { parser: "poste-table-v1", sourceDigest, initialLineItems: [],
      amountHt: ht, amountTtc: ht * 1.2, evidence: [] },
    pricedItemVerification: { parser: PRICED_EVIDENCE_PARSER, sourceDigest,
      rowsDigest: pricedRowsDigest(items), issues: [] } };
}
export function roofDraft(): ArchitectCorrectionDraft {
  return { headerFr: "Réfection toiture", headerEn: "Roof repair", explanationFr: "", explanationEn: "", summaryEn: "",
    discountHt: "0.00", vatRounding: "bucket", lines: [{
      id: 1, clientKey: "line-1", kind: "priced", descriptionFr: "Réfection toiture", descriptionEn: "Roof repair",
      explanationFr: "", explanationEn: "", quantity: "1.000", unit: "u", unitPriceHt: "100.00",
      totalHt: "100.00", vatRate: "20", included: true,
    }] };
}
const header = "Description     Qté     P.U. HT     Montant HT     Montant TTC     TVA";
const zero = (text: string) => `${text}     0,00     0,00     0,00     0,00     0,00`;
const charge = "TOTAL DU POSTE     1,00     100,00     100,00     120,00     20,00";
export const poolPages = [
  `${header}\n${zero("LOT PS PISCINE")}\n${zero("PS.26 Diagnostic")}\n${charge}\n${zero("PS.27 Pompe à chaleur")}\n${zero("• Fourniture de la pompe")}\nSiret : footer`,
  `${header}\n${zero("• Raccordement et mise en service")}\n${charge}\nSiret : footer`,
  `${header}\nDevis gratuit\nTotal HT     200,00\nTotal TTC     240,00`,
];
export const equalPriceJoinery = [
  workingRow(1, "Window A aluminium double glazing"),
  workingRow(2, "Window B timber triple glazing"),
];
