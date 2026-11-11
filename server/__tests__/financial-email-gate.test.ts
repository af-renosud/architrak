import { describe, it, expect, vi } from "vitest";
import { evaluateFinancialPdf, emailNeedsAttention, emailVisibleByDefault } from "../../shared/email-financial-gate";
import { triageFinancialPdf, emailBodyText } from "../gmail/financial-pdf-triage";

const projects = [
  { id: 1, name: "Villa Martin", clientName: "Jean Martin", code: "123" },
  { id: 2, name: "Maison Durand", clientName: "Alice Durand", code: "456" },
];
describe("strict financial content admission", () => {
  it("finds a right-column title without mistaking a plan@ email address for a plan", () => {
    expect(evaluateFinancialPdf("Contractor company                  Devis en €\nJean Martin\nplan@example.fr\nTotal TTC 120", "", projects).status).toBe("eligible");
    expect(evaluateFinancialPdf("DEVIS 123\nJean Martin\nPlan coupe du batiment\nTotal TTC 120", "", projects).status).toBe("eligible");
  });
  it.each(["DEVIS", "FACTURE", "FACTURE D'ACOMPTE", "FACTURE D’HONORAIRES", "AVENANT", "FACTURE D'AVOIR", "AVOIR", "SITUATION DE TRAVAUX", "BON DE COMMANDE", "DGD", "AVIS DE VIREMENT"])("admits %s with exact PDF client", heading => {
    expect(evaluateFinancialPdf(`${heading} N° 42\nClient : Jean Martin\nTotal TTC 1200`, "", projects).status).toBe("eligible");
  });
  it.each(["HT", "H.T.", "TTC", "T.T.C.", "TVA", "T.V.A.", "hors taxes", "toutes taxes comprises", "taxe sur la valeur ajoutée"])("records strong evidence %s", marker => {
    const result = evaluateFinancialPdf(`DEVIS 123\nJean Martin\nTotal ${marker} 1200`, "", projects);
    expect(result.financialMarkers.length).toBeGreaterThan(0);
    expect(result.financialAmountLines).toHaveLength(1);
  });
  it.each(["PLAN RDC", "FICHE TECHNIQUE", "CATALOGUE", "CERTIFICAT DE PAIEMENT"])("excludes %s despite financial references", heading => {
    expect(evaluateFinancialPdf(`${heading}\nJean Martin\nDEVIS 42\nHT 100 TTC 120 TVA 20`, "", projects).status).toBe("financial_excluded");
  });
  it("recognises the whole word devis anywhere in the PDF", () => {
    for (const title of ["Réf. Devis : DV261082", "Objet du devis", "Voir devis joint", "DEVIS N° 42"]) {
      expect(evaluateFinancialPdf(`Jean Martin\n${"Company information\n".repeat(50)}${title}\nTotal TTC 120`, "", projects).status).toBe("eligible");
    }
    expect(evaluateFinancialPdf("Jean Martin\nDevise EUR\nTotal TTC 120", "", projects).status).toBe("financial_excluded");
    expect(evaluateFinancialPdf("Réf. Devis : 42\nUnknown client\nTotal TTC 120", "", projects).status).toBe("financial_identity_review");
  });
  it("never substitutes email identity for absent PDF identity", () => {
    expect(evaluateFinancialPdf("FACTURE 123\nTotal TTC 120", "Pour Jean Martin", projects)).toMatchObject({ status: "financial_identity_review", projectId: null, identitySource: null });
    expect(evaluateFinancialPdf("FACTURE 123\nClient : Alice Durand", "Jean Martin", projects).projectId).toBe(2);
    expect(evaluateFinancialPdf("FACTURE 123\nClient : Unrelated Person", "Jean Martin", projects).status).toBe("financial_identity_review");
  });
  it.each(["Martin Jean", "MARTIN, JEAN", "Martin\nJean"])("accepts surname-first client %s only inside PDF", name => {
    expect(evaluateFinancialPdf(`DEVIS 123\n${name}\nTTC 120`, "", projects)).toMatchObject({ status: "eligible", projectId: 1, identitySource: "pdf" });
    expect(evaluateFinancialPdf("FACTURE 123\nTTC 120", `Pour ${name}`, projects)).toMatchObject({ status: "financial_identity_review", projectId: null });
  });
  it("accepts reversed labelled names and compound first/last names", () => {
    expect(evaluateFinancialPdf("DEVIS 123\nClient : MARTIN Jean\nTTC 120", "", projects).status).toBe("eligible");
    const compound = [{ id: 4, name: "Villa du Parc", clientName: "Jean-Pierre de la Tour" }];
    expect(evaluateFinancialPdf("DEVIS 123\nClient : DE LA TOUR Jean-Pierre\nTTC 120", "", compound).projectId).toBe(4);
  });
  it("keeps ambiguity, conflicts, partial names and archived projects protected with reversed names", () => {
    const shared = [...projects, { id: 3, name: "Autre villa", clientName: "Martin Jean", code: "789" }];
    expect(evaluateFinancialPdf("DEVIS 123\nClient : Martin Jean", "", shared).status).toBe("financial_identity_review");
    expect(evaluateFinancialPdf("DEVIS 123\nClient : Martin Jean\nProjet : Autre villa", "", shared).projectId).toBe(3);
    expect(evaluateFinancialPdf("DEVIS 123\nClient : Martin Jean\nCode projet : 789", "", shared).projectId).toBe(3);
    expect(evaluateFinancialPdf("DEVIS 123\nClient : Martin Jean\nClient : Durand Alice", "", projects).status).toBe("financial_identity_review");
    expect(evaluateFinancialPdf("DEVIS 123\nClient : Durand Alice", "Martin Jean", projects).projectId).toBe(2);
    for (const name of ["Martin", "Martine Jean", "Martin Paul Jean"]) {
      expect(evaluateFinancialPdf(`DEVIS 123\nClient : ${name}`, "Jean Martin", projects).status).toBe("financial_identity_review");
    }
    expect(evaluateFinancialPdf("DEVIS 123\nClient : Martin Jean", "", [{ ...projects[0], archivedAt: "2026-01-01" }]).status).toBe("archived_project_candidate");
  });
  it("does not fuzzy-match or match fragments", () => {
    expect(evaluateFinancialPdf("DEVIS 123\nJean Martine\nHT 100", "", projects).status).toBe("financial_identity_review");
    expect(evaluateFinancialPdf("DEVIS 123\nMartin\nHT 100", "", projects).status).toBe("financial_identity_review");
  });
  it("rejects conflicting identities and disambiguates identical client names by labelled code", () => {
    expect(evaluateFinancialPdf("DEVIS 123\nJean Martin\nAlice Durand", "", projects).status).toBe("financial_identity_review");
    const duplicate = [...projects, { id: 3, name: "Autre villa", clientName: "Jean Martin", code: "789" }];
    expect(evaluateFinancialPdf("DEVIS 123\nJean Martin\nHT 120", "", duplicate).status).toBe("financial_identity_review");
    expect(evaluateFinancialPdf("DEVIS 123\nJean Martin\nCode projet : 789", "", duplicate).projectId).toBe(3);
    expect(evaluateFinancialPdf("DEVIS 123\nClient : Jean Martin\nProjet : Autre villa", "", duplicate).projectId).toBe(3);
    expect(evaluateFinancialPdf("DEVIS 123\nJean Martin\nVilla Martin\nAutre villa", "", duplicate).status).toBe("financial_identity_review");
    expect(evaluateFinancialPdf("DEVIS 123\nJean Martin\nAutre villa\nAlice Durand", "", duplicate).status).toBe("financial_identity_review");
    expect(evaluateFinancialPdf("DEVIS 123\nJean Martin\nAutre villa\nCode projet : 123", "", duplicate).status).toBe("financial_identity_review");
  });
  it("preserves archived clients and payment receipts without tax words", () => {
    expect(evaluateFinancialPdf("FACTURE 123\nJean Martin", "", [{ ...projects[0], archivedAt: "2026-01-01" }]).status).toBe("archived_project_candidate");
    expect(evaluateFinancialPdf("REÇU DE PAIEMENT\nJean Martin\n100 euros", "", projects).status).toBe("eligible");
  });
  it("hides parked items but surfaces read failures consistently", () => {
    for (const status of ["financial_excluded", "financial_identity_review", "unmatched_sender", "low_relevance"]) {
      expect(emailVisibleByDefault({ extractionStatus: status })).toBe(false);
      expect(emailNeedsAttention({ extractionStatus: status })).toBe(false);
    }
    expect(emailNeedsAttention({ extractionStatus: "financial_unreadable" })).toBe(true);
  });
});
describe("PDF triage boundary", () => {
  it("does not reuse an old email-qualified admission", async () => {
    const buffer = Buffer.from("%PDF-1.7 legacy");
    const reader = vi.fn().mockResolvedValue({ text: "FACTURE 123\nTotal TTC 120", method: "text" });
    const previous = await triageFinancialPdf(buffer, "Jean Martin", projects, undefined, reader);
    const legacy = { ...previous, version: 3, decision: { ...previous.decision, status: "eligible", projectId: 1, identitySource: "email" } };
    const next = await triageFinancialPdf(buffer, "Jean Martin", projects, legacy, reader);
    expect(next.decision).toMatchObject({ status: "financial_identity_review", projectId: null, identitySource: null });
    expect(reader).toHaveBeenCalledTimes(2);
  });
  it("reports normalized PDF name evidence and accepts project-only identity", () => {
    const result = evaluateFinancialPdf("DEVIS 42\nVILLA MARTIN\nTTC 120", "", projects);
    expect(result).toMatchObject({ status: "eligible", projectId: 1, identitySource: "pdf" });
    expect(result.reason).toContain('PDF name match: "Villa Martin"');
    expect(evaluateFinancialPdf("FACTURE 42\nÉlodie, DUPRÉ\nTTC 120", "", [
      { id: 3, name: "Maison Est", clientName: "Elodie Dupre" },
    ]).status).toBe("eligible");
  });
  it("rejects fake PDFs without calling recognition", async () => {
    const reader = vi.fn();
    const r = await triageFinancialPdf(Buffer.from("not PDF"), "", projects, undefined, reader);
    expect(r.decision.status).toBe("financial_excluded");
    expect(reader).not.toHaveBeenCalled();
  });
  it("reuses fingerprint-bound OCR and re-evaluates project state", async () => {
    const reader = vi.fn().mockResolvedValue({ text: "FACTURE 123\nJean Martin\nTTC 120", method: "ocr" });
    const buffer = Buffer.from("%PDF-1.7 scanned");
    const first = await triageFinancialPdf(buffer, "", projects, undefined, reader);
    const next = await triageFinancialPdf(buffer, "", [{ ...projects[0], archivedAt: "2026" }], first, reader);
    expect(next.decision.status).toBe("archived_project_candidate");
    expect(reader).toHaveBeenCalledTimes(1);
    await triageFinancialPdf(Buffer.from("%PDF-1.7 changed"), "", projects, first, reader);
    expect(reader).toHaveBeenCalledTimes(2);
  });
  it("does not turn OCR failures into exclusions", async () => {
    await expect(triageFinancialPdf(Buffer.from("%PDF-1.7"), "", projects, undefined, async () => { throw new Error("OCR unavailable"); })).rejects.toThrow("OCR unavailable");
  });
  it("reads email text but not attachment bodies", () => {
    const body = (text: string) => ({ data: Buffer.from(text).toString("base64url") });
    expect(emailBodyText([{ mimeType: "text/plain", body: body("Jean Martin") }, { mimeType: "text/plain", filename: "other.txt", body: body("Alice Durand") }])).toBe("Jean Martin");
  });
});
