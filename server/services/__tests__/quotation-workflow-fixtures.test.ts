import { describe, expect, it, vi } from "vitest";
// Pure helpers only: ensure this suite never opens a database or object store.
vi.mock("../../db", () => ({ pool: {} }));
vi.mock("../../storage/object-storage", () => ({ getDocumentBuffer: vi.fn() }));
import { draftFrom, correctedFinancialBlocker } from "../architect-quotation-correction";
import { financialProjection } from "../../../shared/architect-quotation";
import { recoverPosteTable } from "../quotation-poste-table";
import { collectPricedEvidence, pricedRowsDigest } from "../quotation-priced-evidence";
import { evaluateFinancialPdf, discardIrrelevantFinancialDecision } from "../../../shared/email-financial-gate";
import { roofDraft, poolPages, equalPriceJoinery, sourceBytes, cleanImport } from "./fixtures/quotation-workflow";

describe("synthetic workflow incident fixtures", () => {
  it("roof: missing VAT stays missing; source TTC equality is not a substitute", () => {
    const draft = roofDraft(); draft.lines[0].vatRate = "";
    expect(correctedFinancialBlocker(draft, { ttc: "120.00" })).toContain("VAT");
  });
  it("roof: content-only edits do not change the financial projection", () => {
    const draft = roofDraft(), before = financialProjection(draft);
    draft.lines[0].descriptionEn = "Reviewed roofing description";
    draft.summaryEn = "Architect context";
    expect(financialProjection(draft)).toBe(before);
    expect(correctedFinancialBlocker(draft, { ttc: "120.00" }, { ht: "100.00", ttc: "120.00" })).toBeNull();
  });
  it("roof: financial changes cannot manufacture a new source baseline", () => {
    const draft = roofDraft();
    expect(correctedFinancialBlocker(draft, null)).toContain("Confirm the original quotation total");
    draft.lines[0].totalHt = "101.00";
    expect(correctedFinancialBlocker(draft, { ttc: "120.00" })).toContain("don't match the original total");
  });
  it("roof: PostgreSQL numeric JSON and numeric strings produce equivalent financial values", () => {
    const state = { quotation: { ai_extracted_data: { tvaRate: 20 } }, translation: null, baseline: null, state: null,
      lines: [{ id: 1, line_number: 1, description: "Roof", quantity: 1, unit: "u", unit_price_ht: 100, total_ht: 100 }] };
    expect(correctedFinancialBlocker(draftFrom(state), { ttc: "120.00" }, { ht: "100.00", ttc: "120.00" })).toBeNull();
  });
  it("pool: cross-page heater description belongs to one charge; no router is invented", () => {
    const result = recoverPosteTable(poolPages)!;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1].description).toContain("Fourniture de la pompe");
    expect(result.rows[1].description).toContain("Raccordement et mise en service");
    expect(result.evidence[1].pages).toEqual([1, 2]);
    expect(JSON.stringify(result.rows)).not.toMatch(/router|routeur/i);
  });
  it("pool: unsupported extra charge cannot become verified merely by supplying a matching header", () => {
    const parsed = { documentType: "quotation" as const, amountHt: 300, amountTtc: 360,
      lineItems: [{ description: "Heater", total: 200 }, { description: "Unsupported router", total: 100 }] };
    expect(collectPricedEvidence(parsed, sourceBytes).issues.length).toBeGreaterThan(0);
  });
  it("joinery: equal prices do not collapse distinct product descriptions", () => {
    const items = cleanImport(equalPriceJoinery).lineItems!;
    expect(items).toHaveLength(2);
    const swapped = items.map((item, index) => ({ ...item, description: items[1 - index].description }));
    expect(swapped.reduce((n, row) => n + row.total!, 0)).toBe(200);
    expect(pricedRowsDigest(swapped)).not.toBe(pricedRowsDigest(items));
  });
  it("intake: an active-project plan is excluded even when email says devis", () => {
    const projects = [{ id: 901, name: "SYNTHETIC ORCHARD", clientName: "Example Client", status: "active", archivedAt: null }];
    const decision = evaluateFinancialPdf("PLAN DE MASSE\nProjet SYNTHETIC ORCHARD\nÉchelle 1:100", "Devis Total TTC 120", projects);
    expect(decision.status).toBe("financial_excluded");
    expect(discardIrrelevantFinancialDecision(decision)).toBe(true);
  });
  it("intake: an eligible financial PDF requires its own active-project identity", () => {
    const projects = [{ id: 901, name: "SYNTHETIC ORCHARD", clientName: "Example Client", status: "active", archivedAt: null }];
    const text = "DEVIS\nProjet SYNTHETIC ORCHARD\nTravaux toiture\nTotal HT 100\nTotal TTC 120";
    expect(evaluateFinancialPdf(text, "", projects).status).toBe("eligible");
    expect(evaluateFinancialPdf(text, "", [{ ...projects[0], status: "archived" }]).status).toBe("archived_project_candidate");
  });
});
