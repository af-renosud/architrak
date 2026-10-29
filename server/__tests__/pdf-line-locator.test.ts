import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { PDF_LINE_LOCATOR_SCRIPT } from "../services/pdf-line-locator-script";

type Row = { text: string; x: number; y: number; w: number; h: number };
type Page = { pageNumber: number; rows: Row[] };
type Line = { description: string; total?: string; previousDescription?: string; nextDescription?: string };
const context = vm.createContext({});
vm.runInContext(PDF_LINE_LOCATOR_SCRIPT, context);
const locate = context.locatePdfLine as (pages: Page[], line: Line) => { page: number; bbox: Omit<Row, "text"> } | null;
const row = (text: string, y = 0.5): Row => ({ text, x: 0.1, y, w: 0.8, h: 0.012 });
describe("PDF text-based row locator", () => {
  it("finds the shower tray, not nearby radiator rows", () => {
    const result = locate([{ pageNumber: 2, rows: [
      row("Radiateur panneau acier 2,00 1049,39", 0.4),
      row("Receveur néo plus 140x90 1,00 770,19", 0.6),
    ] }], { description: "Receveur neopl.rec.neoplus 140x90", total: "770.19" });
    expect(result?.bbox.y).toBe(0.6);
  });
  it("searches every page rather than trusting a saved page index", () => {
    expect(locate([{ pageNumber: 1, rows: [row("Autre produit 100,00")] },
      { pageNumber: 3, rows: [row("Armoire encastrer burgbad 100 cm 2198,72")] }],
    { description: "Armoire encastrer burgbad 100 cm", total: "2198.72" })?.page).toBe(3);
  });
  it("refuses ambiguous identical ecoparticipation rows", () => {
    expect(locate([{ pageNumber: 2, rows: [row("Ecoparticipation 1,75", 0.3), row("Ecoparticipation 1,75", 0.8)] }],
      { description: "Écoparticipation", total: "1.75" })).toBeNull();
  });
  it("uses neighbouring product context to disambiguate repeated charges", () => {
    expect(locate([{ pageNumber: 2, rows: [
      row("Radiateur panneau acier 1049,39", 0.2), row("Ecoparticipation 1,75", 0.22),
      row("Receveur douche blanc 770,19", 0.6), row("Ecoparticipation 1,75", 0.62),
    ] }], { description: "Ecoparticipation", total: "1.75", previousDescription: "Receveur douche blanc" })?.bbox.y).toBe(0.62);
  });
  it("does not match contradictory dimensions or totals", () => {
    const pages = [{ pageNumber: 1, rows: [row("Receveur douche blanc 120x90 770,19")] }];
    expect(locate(pages, { description: "Receveur douche blanc 140x90", total: "770.19" })).toBeNull();
    expect(locate(pages, { description: "Receveur douche blanc 120x90", total: "999.00" })).toBeNull();
  });
  it("unions wrapped descriptions without including the next priced item", () => {
    const found = locate([{ pageNumber: 1, rows: [
      row("Armoire encastrer", 0.3), row("burgbad blanc 2198,72", 0.315), row("Autre meuble 100,00", 0.33),
    ] }], { description: "Armoire encastrer burgbad blanc", total: "2198.72" });
    expect(found?.bbox.y).toBe(0.3);
    expect(found?.bbox.h).toBeCloseTo(0.027);
  });
  it("returns no exact box for image-only PDFs or unrelated text", () => {
    expect(locate([{ pageNumber: 1, rows: [] }], { description: "Receveur douche", total: "770.19" })).toBeNull();
    expect(locate([{ pageNumber: 1, rows: [row("Radiateur panneau 770,19")] }], { description: "Receveur douche", total: "770.19" })).toBeNull();
  });
  it("converts glyph geometry through the viewport including crop and rotation", () => {
    const boxes = context.pdfLocatorTextBoxes({
      items: [{ str: "Test", width: 40, transform: [10, 0, 0, 10, 20, 30], fontName: "f" }],
      styles: { f: { ascent: 0.8, descent: -0.2 } },
    }, { width: 200, height: 100, convertToViewportPoint: (x: number,y: number) => [y-10,x-10] });
    expect(boxes[0]).toMatchObject({ x: 0.09, y: 0.1 });
    expect(boxes[0].w).toBeCloseTo(0.05);
    expect(boxes[0].h).toBeCloseTo(0.4);
  });
});
