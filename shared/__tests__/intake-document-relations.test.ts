import { describe, expect, it } from "vitest";
import {
  extractAuditableReferences,
  resolveIntakeDocumentRelationship,
  type RelationDevis,
  type RelationOrder,
} from "../intake-document-relations";

const devis: RelationDevis[] = [
  { id: 1, contractorId: 7, devisNumber: "DE00000392", devisCode: "MN.1.MENU", status: "accepted", accountingState: "active" },
  { id: 2, contractorId: 7, devisNumber: "DE00000400", devisCode: "MN.2.MENU", status: "accepted", accountingState: "active" },
  { id: 3, contractorId: 9, devisNumber: "DE00000999", devisCode: "PL.1.PLOMB", status: "accepted", accountingState: "active" },
];

const command: RelationOrder = {
  id: 11,
  devisId: 1,
  extractedData: {
    documentType: "commande",
    reference: "CM00000195",
    relatedDocumentReferences: [{ kind: "quotation", reference: "DE00000392", evidenceText: "Commande relative au devis DE00000392" }],
  },
};

describe("intake document relationship resolver", () => {
  it("retains own invoice identity while using explicit order evidence as its parent", () => {
    const refs = extractAuditableReferences({
      documentType: "acompte",
      invoiceNumber: "FD00000125",
      relatedDocumentReferences: [{
        kind: "order",
        reference: "CM00000195",
        evidenceText: "Acompte sur la commande n° CM00000195",
        page: 1,
      }],
    });
    expect(refs).toContainEqual(expect.objectContaining({ kind: "invoice", reference: "FD00000125", own: true }));
    expect(refs).toContainEqual(expect.objectContaining({ kind: "order", reference: "CM00000195", own: false }));
    const resolution = resolveIntakeDocumentRelationship({
      parsed: {
        documentType: "acompte",
        invoiceNumber: "FD00000125",
        relatedDocumentReferences: [{ kind: "order", reference: "CM00000195", evidenceText: "Acompte sur la commande n° CM00000195" }],
      },
      contractorId: 7,
      allDevis: devis,
      orders: [command],
    });
    expect(resolution).toMatchObject({ outcome: "resolved", devisId: 1, route: "order" });
    if (resolution.outcome === "resolved") expect(resolution.explanation).toContain("FD00000125 -> CM00000195 -> DE00000392");
  });

  it("supports invoice-first then an order, and every invoice in the progress/final series", () => {
    const invoice = (number: string) => ({
      documentType: "invoice",
      invoiceNumber: number,
      relatedDocumentReferences: [{ kind: "order" as const, reference: "CM00000195", evidenceText: `Facture ${number}, commande CM00000195` }],
    });
    const before = resolveIntakeDocumentRelationship({ parsed: invoice("FA-ACOMPTE"), contractorId: 7, allDevis: devis, orders: [] });
    expect(before).toMatchObject({ outcome: "parked", code: "reference_not_found" });

    for (const number of ["FA-ACOMPTE", "FA-SITUATION-1", "FA-SITUATION-2", "FA-SOLDE"]) {
      expect(resolveIntakeDocumentRelationship({
        parsed: invoice(number),
        contractorId: 7,
        allDevis: devis,
        orders: [command],
      })).toMatchObject({ outcome: "resolved", devisId: 1 });
    }
  });

  it("recovers the historical stored line-description evidence without re-parsing", () => {
    const refs = extractAuditableReferences({
      documentType: "acompte",
      invoiceNumber: "FD00000125",
      lineItems: [{ description: "Acompte sur la commande n° CM00000195", pageHint: 1 }],
    });
    expect(refs).toContainEqual(expect.objectContaining({
      kind: "order",
      reference: "CM00000195",
      evidenceText: "Acompte sur la commande n° CM00000195",
      page: 1,
    }));
    // The original commande extraction used devisNumber before typed related
    // references existed; it remains a bounded legacy order -> devis edge.
    expect(resolveIntakeDocumentRelationship({
      parsed: { documentType: "commande", reference: "CM00000195", devisNumber: "DE00000392" },
      contractorId: 7,
      allDevis: devis,
      orders: [],
    })).toMatchObject({ outcome: "resolved", devisId: 1 });
  });

  it("uses direct quoted devis evidence even with multiple devis for the contractor", () => {
    expect(resolveIntakeDocumentRelationship({
      parsed: {
        documentType: "invoice",
        invoiceNumber: "FA-42",
        relatedDocumentReferences: [{ kind: "quotation", reference: "de 00000392", evidenceText: "Facture sur devis de 00000392" }],
      },
      contractorId: 7,
      allDevis: devis,
      orders: [],
    })).toMatchObject({ outcome: "resolved", devisId: 1, route: "quotation" });
  });

  it("rejects duplicate revisions, contractor conflicts, unsupported evidence, and inactive targets", () => {
    const duplicate = [...devis, { ...devis[0], id: 12, devisCode: "MN.3.REVISION" }];
    expect(resolveIntakeDocumentRelationship({
      parsed: { documentType: "invoice", invoiceNumber: "FA-42", relatedDocumentReferences: [{ kind: "quotation", reference: "DE00000392", evidenceText: "Devis DE00000392" }] },
      contractorId: 7, allDevis: duplicate, orders: [],
    })).toMatchObject({ outcome: "parked", code: "ambiguous_quotation_reference" });
    expect(resolveIntakeDocumentRelationship({
      parsed: { documentType: "invoice", invoiceNumber: "FA-42", relatedDocumentReferences: [{ kind: "quotation", reference: "DE00000999", evidenceText: "Devis DE00000999" }] },
      contractorId: 7, allDevis: devis, orders: [],
    })).toMatchObject({ outcome: "parked", code: "contractor_conflict" });
    expect(resolveIntakeDocumentRelationship({
      parsed: {
        documentType: "invoice", invoiceNumber: "FA-42",
        relatedDocumentReferences: [{ kind: "quotation", reference: "DE00000392", evidenceText: "unrelated wording" }],
      },
      contractorId: 7, allDevis: devis, orders: [],
    })).toMatchObject({ outcome: "parked", code: "no_explicit_relationship" });
    expect(resolveIntakeDocumentRelationship({
      parsed: { documentType: "invoice", invoiceNumber: "FA-42", relatedDocumentReferences: [{ kind: "quotation", reference: "DE00000392", evidenceText: "Devis DE00000392" }] },
      contractorId: 7, allDevis: [{ ...devis[0], status: "void" }], orders: [],
    })).toMatchObject({ outcome: "parked", code: "inactive_devis" });
  });

  it("fails closed on an extra unknown parent and on a contradictory order total, never on deposit amount", () => {
    expect(resolveIntakeDocumentRelationship({
      parsed: {
        documentType: "invoice", invoiceNumber: "FA-X",
        relatedDocumentReferences: [
          { kind: "quotation", reference: "DE00000392", evidenceText: "Devis DE00000392" },
          { kind: "order", reference: "CM-MISSING", evidenceText: "Commande CM-MISSING" },
        ],
      },
      contractorId: 7, allDevis: devis, orders: [],
    })).toMatchObject({ outcome: "parked", code: "reference_not_found" });
    expect(resolveIntakeDocumentRelationship({
      parsed: { documentType: "invoice", invoiceNumber: "FD-100", amountHt: 100, relatedDocumentReferences: [{ kind: "order", reference: "CM00000195", evidenceText: "Commande CM00000195" }] },
      contractorId: 7,
      allDevis: [{ ...devis[0], amountHt: "1000.00" }],
      orders: [{ ...command, extractedData: { documentType: "commande", reference: "CM00000195", amountHt: 1000 } }],
    })).toMatchObject({ outcome: "resolved", devisId: 1 });
    expect(resolveIntakeDocumentRelationship({
      parsed: { documentType: "commande", reference: "CM00000195", devisNumber: "DE00000392", amountHt: 999 },
      contractorId: 7,
      allDevis: [{ ...devis[0], amountHt: "1000.00" }],
      orders: [],
    })).toMatchObject({ outcome: "parked", code: "contradictory_order_amount" });
    // Typed evidence must not suppress contradictory legacy labelled text.
    expect(resolveIntakeDocumentRelationship({
      parsed: {
        documentType: "invoice",
        relatedDocumentReferences: [{ kind: "quotation", reference: "DE00000392", evidenceText: "Devis DE00000392" }],
        lineItems: [{ description: "Commande n° CM-UNKNOWN" }],
      },
      contractorId: 7, allDevis: devis, orders: [],
    })).toMatchObject({ outcome: "parked", code: "reference_not_found" });
  });
});