import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
// @ts-expect-error — no bundled types; used only to recalculate formulas in tests.
import FormulaParser from "fast-formula-parser";
import { computeWorksheet, detectLotHeading, formatCents, type WorksheetLineData } from "../../../shared/quotation-worksheet";
import { buildWorksheetWorkbook, SHEET } from "../quotation-worksheet-excel";
import type { WorksheetDetail } from "../quotation-worksheet";

let nextId = 1;
const line = (p: Partial<WorksheetLineData>): WorksheetLineData => ({
  id: nextId++, sourceLineItemId: 1000 + nextId, position: nextId * 10, section: "lot", lotLabel: "Gros oeuvre",
  description: "Line", unit: "u", originalQuantity: null, originalUnitPrice: null, originalTotal: null, vatRate: "20",
  clientQuantity: null, clientUnitPrice: null, note: null, tag: null, ...p,
});
function fixture(): WorksheetLineData[] {
  nextId = 1;
  return [
    line({ description: "Chainage", originalQuantity: "79", originalUnitPrice: "135", originalTotal: "10665", clientQuantity: "79", clientUnitPrice: "135" }),
    line({ description: "Plancher", originalQuantity: "37", originalUnitPrice: "345", originalTotal: "12765", clientQuantity: "30", clientUnitPrice: "345", note: "Client keeps the existing floor upstairs", tag: "cost_saving" }),
    line({ description: "Fossé", originalQuantity: "6", originalUnitPrice: "295", originalTotal: "1770", clientQuantity: "0", clientUnitPrice: "295" }),
    line({ description: "Unpriced option", originalQuantity: "1", clientQuantity: "1" }),
    // Extracted total that qty × price does not reproduce stays the authoritative figure.
    line({ description: "Rounded lump", originalQuantity: "3", originalUnitPrice: "33.33", originalTotal: "100", clientQuantity: "3", clientUnitPrice: "33.33" }),
    line({ sourceLineItemId: null, description: "Extra lintel", originalQuantity: null, clientQuantity: "2", clientUnitPrice: "410.5", tag: "value_added" }),
    line({ lotLabel: "Electricité", description: "Prise", vatRate: "5.5", originalQuantity: "15", originalUnitPrice: "138", originalTotal: "2070", clientQuantity: "15", clientUnitPrice: "120.75" }),
    line({ lotLabel: "Electricité", description: "Unknown VAT", vatRate: null, originalQuantity: "2", originalUnitPrice: "192", originalTotal: "384", clientQuantity: "2", clientUnitPrice: "192" }),
    line({ section: "meeting", lotLabel: "Meeting additions", sourceLineItemId: null, description: "Outdoor socket", clientQuantity: "2", clientUnitPrice: "150", tag: "query_contractor", note: "Ask for IP55 model" }),
    line({ section: "meeting", lotLabel: "Meeting additions", sourceLineItemId: null, description: "Gate motor", clientQuantity: "1", clientUnitPrice: null }),
  ];
}
function detail(lines: WorksheetLineData[], depositPercent: string | null = "30"): WorksheetDetail {
  return {
    worksheet: { id: 1, devisId: 56, title: "Meeting 3 Dec", meetingDate: "2026-12-03", revision: 4, duplicatedFromId: null,
      createdAt: "2026-11-26T08:00:00.000Z", updatedAt: "2026-11-26T09:00:00.000Z", createdBy: "Architect", depositPercent },
    quotation: { id: 56, code: "MXT.3", number: "DV261090", date: "2026-11-10", projectId: 12, projectName: "Venier", projectCode: "VEN",
      clientName: "Client", contractorName: "Mixed Works", amountHt: "0", amountTtc: "0" },
    lines, computed: computeWorksheet(lines, depositPercent), readOnlyReason: null, history: [],
  };
}

const colLetter = (c: number) => String.fromCharCode(64 + c);
/** Recalculates every formula from the workbook itself, as Excel would. */
function evaluator(wb: ExcelJS.Workbook) {
  const memo = new Map<string, unknown>();
  const raw = (sheet: string, row: number, col: number): unknown => {
    const key = `${sheet}!${row}:${col}`;
    if (memo.has(key)) return memo.get(key);
    const cell = wb.getWorksheet(sheet)!.getCell(row, col);
    const v = cell.value as any;
    let out: unknown;
    if (v && typeof v === "object" && "formula" in v) {
      try { out = makeParser().parse(v.formula, { sheet, row, col }); }
      catch (e) { throw new Error(`${sheet}!${cell.address} =${v.formula}: ${(e as Error).message}`); }
    }
    else if (v == null) out = ""; // blank: our formulas only test blanks against ""
    else if (v instanceof Date) out = v.getTime();
    else out = v;
    memo.set(key, out);
    return out;
  };
  // The parser is not re-entrant, so each nested evaluation gets its own.
  const makeParser = () => new FormulaParser({
    onCell: ({ sheet, row, col }: any) => raw(sheet, row, col),
    onRange: (ref: any) => {
      const rows: unknown[][] = [];
      for (let r = ref.from.row; r <= ref.to.row; r++) {
        const row: unknown[] = [];
        for (let c = ref.from.col; c <= ref.to.col; c++) row.push(raw(ref.sheet, r, c));
        rows.push(row);
      }
      return rows;
    },
  });
  return { value: (sheet: string, addr: string) => { const c = wb.getWorksheet(sheet)!.getCell(addr); return raw(sheet, Number(c.row), Number(c.col)); }, reset: () => memo.clear() };
}
const euro = (cents: number | null) => (cents == null ? "" : cents / 100);
const close = (a: unknown, b: unknown) => {
  if (typeof b === "number") expect(Number(a)).toBeCloseTo(b, 2);
  else expect(a).toBe(b);
};

describe("client worksheet Excel export", () => {
  it("every formula recalculates to the app's own figures", async () => {
    const d = detail(fixture());
    const { buffer } = await buildWorksheetWorkbook(d);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    expect(wb.worksheets.map(w => w.name)).toEqual([SHEET.summary, SHEET.quote, SHEET.points]);
    const ev = evaluator(wb);
    let formulas = 0;
    for (const ws of wb.worksheets) ws.eachRow(row => row.eachCell(cell => {
      const v = cell.value as any;
      if (!v || typeof v !== "object" || !("formula" in v)) return;
      formulas++;
      const got = ev.value(ws.name, cell.address);
      // ExcelJS reads an empty-string or zero cached result back as undefined.
      const expected = v.result === undefined ? (got === 0 ? 0 : "") : v.result;
      if (typeof expected === "number") expect(Number(got), `${ws.name}!${cell.address} =${v.formula}`).toBeCloseTo(expected, 2);
      else expect(got, `${ws.name}!${cell.address} =${v.formula}`).toBe(expected);
    }));
    expect(formulas).toBeGreaterThan(40);
  });

  it("totals, VAT by rate, TTC and deposit reference the right cells and match the app", async () => {
    const d = detail(fixture());
    const { buffer, map } = await buildWorksheetWorkbook(d);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const q = wb.getWorksheet(SHEET.quote)!;
    const ev = evaluator(wb);
    const c = d.computed;
    // Sanity against hand arithmetic: 10665 + 30×345 + 0 + 100 + 2×410.50 = 21936 | 15×120.75 + 384 | 2×150.
    expect(formatCents(c.revised.htCents)).toBe("24431.25");
    expect(c.vat).toEqual([
      { rate: "20", originalVatCents: 506000, revisedVatCents: 444720 },
      { rate: "5.5", originalVatCents: 11385, revisedVatCents: 9962 },
    ]);
    expect(c.unknownVatLineCount).toBe(1);
    expect(c.notPricedCount).toBe(2);

    close(ev.value(SHEET.quote, `J${map.totalRow}`), euro(c.revised.htCents));
    close(ev.value(SHEET.quote, `G${map.totalRow}`), euro(c.original.htCents));
    for (const [i, v] of map.vatRows.entries()) {
      const formula = (q.getCell(`J${v.row}`).value as any).formula as string;
      expect(formula).toBe(`ROUND(SUMIF(M$${map.firstLineRow}:M$${map.lastLineRow},M${v.row},J$${map.firstLineRow}:J$${map.lastLineRow})*M${v.row}/100,2)`);
      expect(q.getCell(`M${v.row}`).value).toBe(Number(c.vat[i].rate));
      close(ev.value(SHEET.quote, `J${v.row}`), euro(c.vat[i].revisedVatCents));
    }
    close(ev.value(SHEET.quote, `J${map.ttcRow}`), euro(c.revised.ttcCents));
    // Deposit uses the deposit % input cell — never a date or another field.
    const depositFormula = (q.getCell(`J${map.depositRow}`).value as any).formula as string;
    expect(depositFormula).toBe(`IF(${map.depositCell}="","",ROUND(J${map.ttcRow}*${map.depositCell}/100,2))`);
    expect(wb.getWorksheet(SHEET.summary)!.getCell("C10").value).toBe(30);
    expect(wb.getWorksheet(SHEET.summary)!.getCell("B10").value).toBe("Deposit % (of TTC)");
    close(ev.value(SHEET.quote, `J${map.depositRow}`), euro(c.revised.depositCents));
    // The quotation date cell is never an input to any formula (the Gemini workbook bug).
    for (const ws of wb.worksheets) ws.eachRow(row => row.eachCell(cell => {
      const f = (cell.value as any)?.formula as string | undefined;
      if (f) expect(f).not.toMatch(/Executive summary'!\$?C\$?7\b/);
    }));
    // Executive summary rows point at the interactive sheet's totals.
    const s = wb.getWorksheet(SHEET.summary)!;
    const refs: string[] = [];
    s.eachRow(row => row.eachCell(cell => { const f = (cell.value as any)?.formula; if (f) refs.push(f); }));
    expect(refs).toContain(`'${SHEET.quote}'!J${map.totalRow}`);
    expect(refs).toContain(`'${SHEET.quote}'!J${map.ttcRow}`);
    expect(refs).toContain(`'${SHEET.quote}'!J${map.depositRow}`);
  });

  it("editing a client quantity or price in Excel recalculates like the app", async () => {
    const lines = fixture();
    const d = detail(lines);
    const { buffer, map } = await buildWorksheetWorkbook(d);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const q = wb.getWorksheet(SHEET.quote)!;
    const ev = evaluator(wb);
    const unchanged = lines[0], removed = lines[2], meetingUnpriced = lines[9];
    q.getCell(`I${map.lineRows.get(unchanged.id)}`).value = 120;
    q.getCell(`H${map.lineRows.get(removed.id)}`).value = 6;
    q.getCell(`I${map.lineRows.get(meetingUnpriced.id)}`).value = 890;
    wb.getWorksheet(SHEET.summary)!.getCell("C10").value = 40;
    ev.reset();
    const edited = lines.map(l => l.id === unchanged.id ? { ...l, clientUnitPrice: "120" }
      : l.id === removed.id ? { ...l, clientQuantity: "6" } : l.id === meetingUnpriced.id ? { ...l, clientUnitPrice: "890" } : l);
    const app = computeWorksheet(edited, "40");
    for (const l of edited) {
      const r = map.lineRows.get(l.id)!;
      const res = app.lines.find(x => x.id === l.id)!;
      expect(ev.value(SHEET.quote, `L${r}`)).toBe(res.status);
      close(ev.value(SHEET.quote, `J${r}`), euro(res.revisedCents));
    }
    close(ev.value(SHEET.quote, `J${map.totalRow}`), euro(app.revised.htCents));
    close(ev.value(SHEET.quote, `J${map.ttcRow}`), euro(app.revised.ttcCents));
    close(ev.value(SHEET.quote, `J${map.depositRow}`), euro(app.revised.depositCents));
  });

  it("lists noted, tagged and changed lines on Points to check, linked to the live status", async () => {
    const d = detail(fixture(), null);
    const { buffer, map } = await buildWorksheetWorkbook(d);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const p = wb.getWorksheet(SHEET.points)!;
    const descs: string[] = [];
    p.eachRow((row, n) => { if (n >= 4) descs.push(String((row.getCell(3).value as any)?.result ?? row.getCell(3).value)); });
    expect(descs).toEqual(["Plancher", "Fossé", "Unpriced option", "Extra lintel", "Prise", "Outdoor socket", "Gate motor"]);
    const plancher = d.lines[1];
    expect((p.getCell("D4").value as any).formula).toBe(`'${SHEET.quote}'!L${map.lineRows.get(plancher.id)}`);
    expect(p.getCell("F4").value).toBe("Cost saving");
    // No deposit percentage: deposit cells are blank, not €0.
    const q = wb.getWorksheet(SHEET.quote)!;
    expect((q.getCell(`J${map.depositRow}`).value as any).result ?? "").toBe("");
    expect(evaluator(wb).value(SHEET.quote, `J${map.depositRow}`)).toBe("");
  });
});

describe("lot headings", () => {
  it("reads common contractor lot prefixes", () => {
    expect(detectLotHeading("LOT GROS OEUVRE MACONNERIE Chainage périphérique en béton armé")).toBe("GROS OEUVRE MACONNERIE");
    expect(detectLotHeading("Lot etude\nréalisation d'une reprise")).toBe("Etude");
    expect(detectLotHeading("Lot Electricité Prise de courant 16 A")).toBe("Electricité");
    expect(detectLotHeading("Lot CVC Plomberie Mitigeur")).toBe("CVC");
    expect(detectLotHeading("Réparation structurelle de maçonnerie")).toBeNull();
  });
});
