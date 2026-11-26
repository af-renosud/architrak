import { describe, expect, it } from "vitest";
import type { WorksheetLineData } from "../quotation-worksheet";
import {
  buildRevisionRequestEmail, buildSharedWorksheetPayload, compareWithRevisedQuotation, frNumber, worksheetRevisionChanges,
  type RevisedQuotationLine,
} from "../worksheet-agreement";

const line = (over: Partial<WorksheetLineData>): WorksheetLineData => ({
  id: 1, sourceLineItemId: 10, position: 10, section: "lot", lotLabel: "Lot 1 — Maçonnerie", description: "Démolition cloison",
  unit: "m2", originalQuantity: "10", originalUnitPrice: "50", originalTotal: "500", vatRate: "10",
  clientQuantity: "10", clientUnitPrice: "50", note: null, tag: null, ...over,
});
const lines: WorksheetLineData[] = [
  line({}),
  line({ id: 2, sourceLineItemId: 11, position: 20, description: "Enduit plâtre", originalQuantity: "20", originalUnitPrice: "30", originalTotal: "600", clientQuantity: "15", clientUnitPrice: "30", note: "Client garde un mur" }),
  line({ id: 3, sourceLineItemId: 12, position: 30, description: "Carrelage sol", originalQuantity: "5", originalUnitPrice: "100", originalTotal: "500", clientQuantity: "0" }),
  line({ id: 4, sourceLineItemId: null, position: 100, section: "meeting", lotLabel: "Added at meeting", description: "Prise électrique supplémentaire",
    unit: "u", originalQuantity: null, originalUnitPrice: null, originalTotal: null, clientQuantity: "2", clientUnitPrice: "80" }),
  line({ id: 5, sourceLineItemId: null, position: 110, section: "meeting", lotLabel: "Added at meeting", description: "Idée abandonnée",
    unit: "u", originalQuantity: null, originalUnitPrice: null, originalTotal: null, clientQuantity: "0", clientUnitPrice: "10" }),
];

describe("revision request", () => {
  it("lists only added, removed and changed lines; zero-quantity additions are dropped", () => {
    const changes = worksheetRevisionChanges(lines);
    expect(changes.map(c => [c.kind, c.description])).toEqual([
      ["changed", "Enduit plâtre"], ["removed", "Carrelage sol"], ["added", "Prise électrique supplémentaire"],
    ]);
  });

  it("writes a French request with quantities, totals and the reference; notes only on request", () => {
    const changes = worksheetRevisionChanges(lines);
    const base = { projectName: "Maison Dupont", quotationRef: "D-12", documentRef: "2026-045", contactName: "M. Martin",
      meetingDate: "2026-11-20", changes, originalHtCents: 160000, revisedHtCents: 121000, requestId: "abc" };
    const { subject, body } = buildRevisionRequestEmail(base);
    expect(subject).toBe("Demande de devis révisé — Maison Dupont — devis 2026-045");
    expect(body).toContain("Bonjour M. Martin,");
    expect(body).toContain("réunion avec le client du 20/11/2026");
    expect(body).toContain("AJOUTS (1)");
    expect(body).toContain("Quantité : 2 u — prix unitaire HT envisagé : 80,00 €");
    expect(body).toContain("SUPPRESSIONS (1)");
    expect(body).toContain("MODIFICATIONS (1)");
    expect(body).toContain("quantité : 20 m2 → 15 m2");
    expect(body).toContain("1 210,00 € (devis initial : 1 600,00 €)");
    expect(body).not.toContain("Client garde un mur");
    expect(body.endsWith("Référence : AT-RR-abc")).toBe(true);
    expect(buildRevisionRequestEmail({ ...base, includeNotes: true }).body).toContain("Remarque : Client garde un mur");
  });

  it("formats French numbers", () => {
    expect(frNumber("1250.5")).toBe("1 250,5");
    expect(frNumber("-1234567.891", 2)).toBe("-1 234 567,89");
  });
});

describe("sealed client copy", () => {
  it("uses approved English wording, keeps the original, and reports partial translation", () => {
    const p = buildSharedWorksheetPayload({
      title: "Meeting", meetingDate: null, depositPercent: "30", projectName: "Maison Dupont",
      quotation: { ref: "D-12", documentRef: null, contractorName: "SARL Martin", date: null },
      lines, english: new Map([[10, "Partition demolition"]]),
    });
    expect(p.lots[0].lines[0]).toMatchObject({ description: "Partition demolition", originalDescription: "Démolition cloison" });
    expect(p.lots[0].lines[1]).toMatchObject({ description: "Enduit plâtre", originalDescription: null, status: "Modified" });
    expect(p.language).toBe("partial");
    expect(p.revised.htCents).toBe(111000);
    expect(p.revised.depositCents).not.toBeNull();
  });
});

describe("comparison with the revised quotation", () => {
  const revised = (over: Partial<RevisedQuotationLine>): RevisedQuotationLine => ({
    id: 1, lineNumber: 1, description: "Démolition cloison", unit: "m2", quantity: "10", unitPriceHt: "50", totalHt: "500", ...over,
  });
  it("matches by wording and flags each kind of difference", () => {
    const c = compareWithRevisedQuotation(lines, [
      revised({}),
      revised({ id: 2, lineNumber: 2, description: "Enduit platre", quantity: "20", totalHt: "600", unitPriceHt: "30" }),
      revised({ id: 3, lineNumber: 3, description: "Carrelage sol", quantity: "5", unitPriceHt: "100", totalHt: "500" }),
      revised({ id: 4, lineNumber: 4, description: "Nettoyage fin de chantier", quantity: "1", unitPriceHt: "150", totalHt: "150" }),
    ]);
    const by = Object.fromEntries(c.rows.map(r => [r.agreed?.description ?? r.revised!.description, r.status]));
    expect(by).toEqual({
      "Démolition cloison": "as_agreed",
      "Enduit plâtre": "quantity_differs",
      "Carrelage sol": "still_included",
      "Prise électrique supplémentaire": "missing",
      "Nettoyage fin de chantier": "not_in_worksheet",
    });
    expect(c.agreedHtCents).toBe(111000);
    expect(c.revisedLinesHtCents).toBe(175000);
  });

  it("uses a clearly similar wording as a probable match and never matches repeated wording", () => {
    const c = compareWithRevisedQuotation([lines[3]], [
      revised({ id: 9, lineNumber: 9, description: "Fourniture et pose prise électrique supplémentaire", unit: "u", quantity: "2", unitPriceHt: "85", totalHt: "170" }),
    ]);
    expect(c.rows[0]).toMatchObject({ status: "price_differs", match: "similar" });
    const dup = compareWithRevisedQuotation([lines[0]], [revised({ id: 1 }), revised({ id: 2, lineNumber: 2 })]);
    expect(dup.rows.find(r => r.agreed)?.status).toBe("missing");
  });
});
