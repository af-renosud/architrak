import ExcelJS from "exceljs";
import { WORKSHEET_TAGS, cents, groupWorksheetLines, lineKind, productCents, type WorksheetLineData } from "../../shared/quotation-worksheet";
import type { WorksheetDetail } from "./quotation-worksheet";
import { CHECK_CATEGORIES, type QuotationCheckPoint } from "../../shared/quotation-checks";

/**
 * Three-sheet client worksheet workbook with live formulas. Every formula
 * mirrors shared/quotation-worksheet.ts so Excel and ArchiTrak agree; cached
 * results are the app's own figures so viewers that do not recalculate still
 * show correct values. Editable cells (client qty / unit price, deposit %)
 * are highlighted.
 */
export const SHEET = { summary: "Executive summary", quote: "Interactive quote", points: "Points to check" } as const;
const Q = `'${SHEET.quote}'`;
const S = `'${SHEET.summary}'`;
const EUR = '#,##0.00 "€";[Red]-#,##0.00 "€"';
const QTY = "#,##0.###";
const INPUT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4C2" } };
const HEAD_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const LOT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
const TOTAL_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };

const num = (v: string | null) => (v == null ? null : Number(v));
const eur = (c: number | null) => (c == null ? "" : c / 100);
type Result = number | string;
const f = (formula: string, result: Result | null) => ({ formula, result: result ?? "" }) as ExcelJS.CellFormulaValue;

/** Cell addresses the export test (and the summary sheet) rely on. */
export interface WorksheetWorkbookMap {
  lineRows: Map<number, number>;
  lotSubtotalRows: Array<{ label: string; row: number; first: number; last: number }>;
  firstLineRow: number; lastLineRow: number;
  totalRow: number; vatRows: Array<{ rate: string; row: number }>; ttcRow: number; depositRow: number;
  depositCell: string;
  /** First row of the automatic points-to-check table, when any are listed. */
  checksFirstRow: number | null;
}

export async function buildWorksheetWorkbook(detail: WorksheetDetail, options: { checks?: QuotationCheckPoint[] } = {}): Promise<{ buffer: Buffer; map: WorksheetWorkbookMap }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ArchiTrak";
  wb.created = new Date(detail.worksheet.updatedAt);
  wb.calcProperties.fullCalcOnLoad = true;
  const summary = wb.addWorksheet(SHEET.summary, { views: [{ showGridLines: false }] });
  const quote = wb.addWorksheet(SHEET.quote, { views: [{ state: "frozen", ySplit: 5, xSplit: 3 }] });
  const points = wb.addWorksheet(SHEET.points, { views: [{ state: "frozen", ySplit: 3 }] });
  const computed = detail.computed;
  const byId = new Map(computed.lines.map(r => [r.id, r]));
  const q = detail.quotation;
  const DEPOSIT_ROW = 10;
  const depositCell = `${S}!$C$${DEPOSIT_ROW}`;

  // ---------------- Interactive quote ----------------
  quote.columns = [
    { key: "A", width: 7 }, { key: "B", width: 20 }, { key: "C", width: 60 }, { key: "D", width: 7 },
    { key: "E", width: 10 }, { key: "F", width: 13 }, { key: "G", width: 14 }, { key: "H", width: 10 },
    { key: "I", width: 13 }, { key: "J", width: 14 }, { key: "K", width: 13 }, { key: "L", width: 12 },
    { key: "M", width: 7 }, { key: "N", width: 22 }, { key: "O", width: 50 },
  ];
  quote.getCell("A1").value = `Client worksheet — ${q.contractorName} — ${q.number ?? q.code}`;
  quote.getCell("A1").font = { bold: true, size: 14 };
  quote.getCell("A2").value = `${detail.worksheet.title}${detail.worksheet.meetingDate ? ` · meeting ${detail.worksheet.meetingDate}` : ""} · ${q.projectName}`;
  quote.getCell("A3").value = "Edit the yellow cells (client quantity and unit price). Totals, differences, status, VAT, TTC and deposit recalculate. Amounts are HT unless stated.";
  quote.getCell("A3").font = { italic: true, color: { argb: "FF6B7280" } };
  const header = ["Item", "Lot", "Description", "Unit", "Original qty", "Original unit price HT", "Original total HT",
    "Client qty", "Client unit price HT", "Revised total HT", "Difference HT", "Status", "VAT %", "Tag", "Note"];
  const headRow = quote.getRow(5);
  header.forEach((h, i) => {
    const cell = headRow.getCell(i + 1);
    cell.value = h; cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = HEAD_FILL;
    cell.alignment = { wrapText: true, vertical: "middle" };
  });
  headRow.height = 30;

  const groups = groupWorksheetLines(detail.lines);
  const lineRows = new Map<number, number>();
  const lotSubtotalRows: WorksheetWorkbookMap["lotSubtotalRows"] = [];
  let r = 6;
  const firstLineRow = r;
  groups.forEach((g, gi) => {
    const lot = computed.lots[gi];
    const lotRow = quote.getRow(r++);
    lotRow.getCell(1).value = g.section === "meeting" ? "M" : gi + 1;
    lotRow.getCell(2).value = g.label;
    lotRow.getCell(3).value = g.label;
    for (let c = 1; c <= 15; c++) lotRow.getCell(c).fill = LOT_FILL;
    lotRow.font = { bold: true };
    const first = r;
    for (const line of g.lines) {
      const res = byId.get(line.id)!;
      writeLine(quote, r, line, res);
      lineRows.set(line.id, r);
      r++;
    }
    const last = r - 1;
    const sub = quote.getRow(r);
    sub.getCell(3).value = `Sous-total — ${g.label}`;
    sub.getCell(7).value = f(`SUM(G${first}:G${last})`, eur(lot.originalHtCents));
    sub.getCell(10).value = f(`SUM(J${first}:J${last})`, eur(lot.revisedHtCents));
    sub.getCell(11).value = f(`J${r}-G${r}`, eur(lot.revisedHtCents - lot.originalHtCents));
    for (const c of [7, 10, 11]) sub.getCell(c).numFmt = EUR;
    for (let c = 1; c <= 15; c++) sub.getCell(c).fill = TOTAL_FILL;
    sub.font = { bold: true };
    lotSubtotalRows.push({ label: g.label, row: r, first, last });
    r += 2;
  });
  const lastLineRow = r - 2;

  const totalRow = r++;
  const subs = (col: string) => lotSubtotalRows.map(s => `${col}${s.row}`).join(",") || "0";
  const tRow = quote.getRow(totalRow);
  tRow.getCell(3).value = "TOTAL HT";
  tRow.getCell(7).value = f(`SUM(${subs("G")})`, eur(computed.original.htCents));
  tRow.getCell(10).value = f(`SUM(${subs("J")})`, eur(computed.revised.htCents));
  tRow.getCell(11).value = f(`J${totalRow}-G${totalRow}`, eur(computed.revised.htCents - computed.original.htCents));
  const vatRows: WorksheetWorkbookMap["vatRows"] = [];
  for (const v of computed.vat) {
    const row = r++;
    const vr = quote.getRow(row);
    vr.getCell(3).value = `TVA ${v.rate.replace(".", ",")} %`;
    vr.getCell(13).value = Number(v.rate);
    const range = (col: string) => `${col}$${firstLineRow}:${col}$${lastLineRow}`;
    vr.getCell(7).value = f(`ROUND(SUMIF(${range("M")},M${row},${range("G")})*M${row}/100,2)`, eur(v.originalVatCents));
    vr.getCell(10).value = f(`ROUND(SUMIF(${range("M")},M${row},${range("J")})*M${row}/100,2)`, eur(v.revisedVatCents));
    vr.getCell(11).value = f(`J${row}-G${row}`, eur(v.revisedVatCents - v.originalVatCents));
    vatRows.push({ rate: v.rate, row });
  }
  if (computed.unknownVatLineCount) {
    const nr = quote.getRow(r++);
    nr.getCell(3).value = `VAT rate unknown on ${computed.unknownVatLineCount} line(s): their VAT is not included below. Fill in column M in ArchiTrak.`;
    nr.getCell(3).font = { italic: true, color: { argb: "FFB45309" } };
  }
  const ttcRow = r++;
  const vatSum = (col: string) => vatRows.length ? `+${vatRows.map(v => `${col}${v.row}`).join("+")}` : "";
  const ttc = quote.getRow(ttcRow);
  ttc.getCell(3).value = "TOTAL TTC";
  ttc.getCell(7).value = f(`G${totalRow}${vatSum("G")}`, eur(computed.original.ttcCents));
  ttc.getCell(10).value = f(`J${totalRow}${vatSum("J")}`, eur(computed.revised.ttcCents));
  ttc.getCell(11).value = f(`J${ttcRow}-G${ttcRow}`, eur(computed.revised.ttcCents - computed.original.ttcCents));
  const depositRow = r++;
  const dep = quote.getRow(depositRow);
  dep.getCell(3).value = f(`IF(${depositCell}="","Deposit (no percentage set)","Deposit "&${depositCell}&" % of TTC")`,
    detail.worksheet.depositPercent == null ? "Deposit (no percentage set)" : `Deposit ${Number(detail.worksheet.depositPercent)} % of TTC`);
  dep.getCell(7).value = f(`IF(${depositCell}="","",ROUND(G${ttcRow}*${depositCell}/100,2))`, eur(computed.original.depositCents));
  dep.getCell(10).value = f(`IF(${depositCell}="","",ROUND(J${ttcRow}*${depositCell}/100,2))`, eur(computed.revised.depositCents));
  for (const row of [totalRow, ...vatRows.map(v => v.row), ttcRow, depositRow]) {
    const x = quote.getRow(row);
    x.font = { bold: true };
    for (const c of [7, 10, 11]) x.getCell(c).numFmt = EUR;
    for (let c = 1; c <= 15; c++) x.getCell(c).fill = TOTAL_FILL;
  }
  quote.autoFilter = { from: { row: 5, column: 1 }, to: { row: lastLineRow, column: 15 } };

  // ---------------- Executive summary ----------------
  summary.columns = [{ width: 3 }, { width: 34 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 14 }];
  summary.getCell("B2").value = "Client worksheet — executive summary";
  summary.getCell("B2").font = { bold: true, size: 16 };
  const info: Array<[string, ExcelJS.CellValue]> = [
    ["Project", `${q.projectName}${q.projectCode ? ` (${q.projectCode})` : ""}`],
    ["Contractor", q.contractorName],
    ["Quotation", q.number ? `${q.number} · ${q.code}` : q.code],
    ["Quotation date", q.date ? new Date(`${q.date}T00:00:00Z`) : "Not recorded"],
    ["Worksheet", detail.worksheet.title],
    ["Meeting date", detail.worksheet.meetingDate ? new Date(`${detail.worksheet.meetingDate}T00:00:00Z`) : "—"],
  ];
  info.forEach(([label, value], i) => {
    summary.getCell(`B${4 + i}`).value = label;
    summary.getCell(`B${4 + i}`).font = { bold: true };
    const cell = summary.getCell(`C${4 + i}`);
    cell.value = value;
    if (value instanceof Date) cell.numFmt = "dd/mm/yyyy";
  });
  summary.getCell(`B${DEPOSIT_ROW}`).value = "Deposit % (of TTC)";
  summary.getCell(`B${DEPOSIT_ROW}`).font = { bold: true };
  const depCell = summary.getCell(`C${DEPOSIT_ROW}`);
  depCell.value = detail.worksheet.depositPercent == null ? null : Number(detail.worksheet.depositPercent);
  depCell.fill = INPUT_FILL;
  summary.getCell(`D${DEPOSIT_ROW}`).value = "Leave empty if no deposit applies.";
  summary.getCell(`D${DEPOSIT_ROW}`).font = { italic: true, color: { argb: "FF6B7280" } };

  const sh = 12;
  ["Lot", "Original HT", "Revised HT", "Difference HT"].forEach((h, i) => {
    const cell = summary.getRow(sh).getCell(2 + i);
    cell.value = h; cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = HEAD_FILL;
  });
  let sr = sh + 1;
  lotSubtotalRows.forEach((s, i) => {
    const lot = computed.lots[i];
    const row = summary.getRow(sr++);
    row.getCell(2).value = lot.notPricedCount ? `${s.label} (${lot.notPricedCount} not priced)` : s.label;
    row.getCell(3).value = f(`${Q}!G${s.row}`, eur(lot.originalHtCents));
    row.getCell(4).value = f(`${Q}!J${s.row}`, eur(lot.revisedHtCents));
    row.getCell(5).value = f(`${Q}!K${s.row}`, eur(lot.revisedHtCents - lot.originalHtCents));
  });
  const ref = (label: string, row: number, o: number | null, rv: number | null, bold = true) => {
    const x = summary.getRow(sr++);
    x.getCell(2).value = label;
    x.getCell(3).value = f(`${Q}!G${row}`, eur(o));
    x.getCell(4).value = f(`${Q}!J${row}`, eur(rv));
    x.getCell(5).value = f(`IF(OR(C${x.number}="",D${x.number}=""),"",D${x.number}-C${x.number})`, o == null || rv == null ? "" : eur(rv - o));
    x.font = { bold };
    for (let c = 2; c <= 5; c++) x.getCell(c).fill = TOTAL_FILL;
  };
  sr++;
  ref("Total HT", totalRow, computed.original.htCents, computed.revised.htCents);
  computed.vat.forEach((v, i) => ref(`TVA ${v.rate.replace(".", ",")} %`, vatRows[i].row, v.originalVatCents, v.revisedVatCents, false));
  ref("Total TTC", ttcRow, computed.original.ttcCents, computed.revised.ttcCents);
  ref("Deposit", depositRow, computed.original.depositCents, computed.revised.depositCents, false);
  for (let row = sh + 1; row < sr; row++) for (const c of [3, 4, 5]) summary.getRow(row).getCell(c).numFmt = EUR;
  sr++;
  const notes = [
    `Lines: ${computed.counts.Unchanged} unchanged, ${computed.counts.Modified} modified, ${computed.counts.Removed} removed, ${computed.counts.Added} added, ${computed.counts["Not priced"]} not priced (counted at nothing until priced).`,
    computed.unknownVatLineCount ? `VAT rate unknown on ${computed.unknownVatLineCount} line(s); their VAT is not included.` : "VAT uses the rate recorded on each line of the quotation.",
    "The original contractor quotation is unchanged. This worksheet is a working document for discussion, not a contractual quotation.",
  ];
  for (const n of notes) { summary.getCell(`B${sr++}`).value = n; }

  // ---------------- Points to check ----------------
  points.columns = [{ width: 7 }, { width: 20 }, { width: 55 }, { width: 12 }, { width: 14 }, { width: 22 }, { width: 60 }];
  points.getCell("A1").value = "Points to check";
  points.getCell("A1").font = { bold: true, size: 14 };
  ["Item", "Lot", "Description", "Status", "Difference HT", "Tag", "Note"].forEach((h, i) => {
    const cell = points.getRow(3).getCell(i + 1);
    cell.value = h; cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = HEAD_FILL;
  });
  let pr = 4;
  for (const g of groups) for (const line of g.lines) {
    const res = byId.get(line.id)!;
    if (!line.note && !line.tag && res.status === "Unchanged") continue;
    const qr = lineRows.get(line.id)!;
    const row = points.getRow(pr++);
    row.getCell(1).value = f(`${Q}!A${qr}`, res.item);
    row.getCell(2).value = f(`${Q}!B${qr}`, g.label);
    row.getCell(3).value = f(`${Q}!C${qr}`, line.description);
    row.getCell(4).value = f(`${Q}!L${qr}`, res.status);
    row.getCell(5).value = f(`${Q}!K${qr}`, eur(res.differenceCents));
    row.getCell(5).numFmt = EUR;
    row.getCell(6).value = line.tag ? WORKSHEET_TAGS[line.tag] : "";
    row.getCell(7).value = line.note ?? "";
    row.getCell(3).alignment = { wrapText: true, vertical: "top" };
    row.getCell(7).alignment = { wrapText: true, vertical: "top" };
  }
  if (pr === 4) points.getCell("A4").value = "No notes, tags or changes yet.";
  if (pr === 4) pr = 5;

  // Open automatic points to check on the quotation (dismissed points are left out).
  const checks = options.checks ?? [];
  pr += 1;
  points.getCell(`A${pr}`).value = "Automatic points to check on the quotation";
  points.getCell(`A${pr}`).font = { bold: true, size: 12 };
  pr += 1;
  let checksFirstRow: number | null = null;
  if (!checks.length) {
    points.getCell(`A${pr}`).value = "No open points.";
  } else {
    ["Source", "Category", "Lines", "Finding", "", "", "Suggested action"].forEach((h, i) => {
      const cell = points.getRow(pr).getCell(i + 1);
      cell.value = h; cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = HEAD_FILL;
    });
    pr += 1;
    checksFirstRow = pr;
    for (const p of checks) {
      const row = points.getRow(pr);
      row.getCell(1).value = p.source === "ai" ? "AI suggestion" : "Automatic";
      row.getCell(2).value = CHECK_CATEGORIES[p.category];
      row.getCell(3).value = p.lines.map(l => `Line ${l.lineNumber} (${l.lot}): ${l.description}`).join("\n");
      row.getCell(4).value = p.finding;
      points.mergeCells(pr, 4, pr, 6);
      row.getCell(7).value = p.suggestedAction;
      for (const c of [3, 4, 7]) row.getCell(c).alignment = { wrapText: true, vertical: "top" };
      row.getCell(1).alignment = { vertical: "top" };
      row.getCell(2).alignment = { vertical: "top", wrapText: true };
      pr += 1;
    }
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, map: { lineRows, lotSubtotalRows, firstLineRow, lastLineRow, totalRow, vatRows, ttcRow, depositRow, depositCell, checksFirstRow } };
}

function writeLine(ws: ExcelJS.Worksheet, r: number, line: WorksheetLineData, res: { item: string; status: string; originalCents: number | null; revisedCents: number | null; differenceCents: number | null }) {
  const row = ws.getRow(r);
  const kind = lineKind(line);
  row.getCell(1).value = res.item;
  row.getCell(2).value = line.section === "meeting" ? "Meeting additions" : line.lotLabel;
  row.getCell(3).value = line.description;
  row.getCell(3).alignment = { wrapText: true, vertical: "top" };
  row.getCell(4).value = line.unit ?? "";
  row.getCell(5).value = kind === "added" ? null : num(line.originalQuantity);
  row.getCell(6).value = kind === "priced" ? num(line.originalUnitPrice) : null;
  if (kind === "priced") {
    const exact = line.originalQuantity != null && line.originalUnitPrice != null
      && productCents(line.originalQuantity, line.originalUnitPrice) === cents(line.originalTotal!);
    // The extracted total is authoritative; use a formula only when it reproduces it exactly.
    row.getCell(7).value = exact ? f(`ROUND(E${r}*F${r},2)`, eur(res.originalCents)) : eur(res.originalCents);
  } else if (kind === "unpriced") {
    row.getCell(7).value = "Not priced";
  }
  row.getCell(8).value = num(line.clientQuantity);
  row.getCell(9).value = num(line.clientUnitPrice);
  row.getCell(8).fill = INPUT_FILL;
  row.getCell(9).fill = INPUT_FILL;
  if (kind === "priced") {
    row.getCell(10).value = f(`IF(AND(H${r}=E${r},I${r}=F${r}),G${r},ROUND(H${r}*I${r},2))`, eur(res.revisedCents));
    row.getCell(11).value = f(`J${r}-G${r}`, eur(res.differenceCents));
    row.getCell(12).value = f(`IF(H${r}=0,"Removed",IF(AND(H${r}=E${r},I${r}=F${r}),"Unchanged","Modified"))`, res.status);
  } else {
    row.getCell(10).value = f(`IF(OR(H${r}="",I${r}=""),"",ROUND(H${r}*I${r},2))`, eur(res.revisedCents));
    row.getCell(11).value = f(`IF(J${r}="","",J${r})`, eur(res.differenceCents));
    row.getCell(12).value = kind === "added"
      ? f(`IF(J${r}="","Not priced","Added")`, res.status)
      : f(`IF(J${r}="","Not priced",IF(H${r}=0,"Removed","Modified"))`, res.status);
  }
  row.getCell(13).value = num(line.vatRate);
  row.getCell(14).value = line.tag ? WORKSHEET_TAGS[line.tag] : "";
  row.getCell(15).value = line.note ?? "";
  row.getCell(15).alignment = { wrapText: true, vertical: "top" };
  for (const c of [6, 7, 9, 10, 11]) row.getCell(c).numFmt = EUR;
  for (const c of [5, 8]) row.getCell(c).numFmt = QTY;
}
