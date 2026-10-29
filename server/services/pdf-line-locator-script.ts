/**
 * Shared source for the standalone contractor portal (no frontend bundle).
 * Tested by executing this exact script, not a second implementation.
 * Saved AI boxes/page hints are deliberately not matching evidence.
 */
export const PDF_LINE_LOCATOR_SCRIPT = String.raw`
function pdfLocatorTokens(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/neopl(?:us)?/g, "neo plus").replace(/\brec\b/g, "receveur").replace(/(\d)[x×](?=\d)/g, "$1 ")
    .replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter(t => t.length > 1 && !["de", "du", "des", "la", "le", "les", "en", "et", "ht", "ttc", "avec", "pour"].includes(t));
}
function pdfLocatorAmounts(text) {
  const matches = String(text).match(/(?:\d{1,3}(?:[ .\u00a0]\d{3})+|\d+)[,.]\d{2}(?!\d)/g) || [];
  return matches.map(s => {
    const digits = s.replace(/[^\d]/g, "");
    return Number(digits) / 100;
  });
}
function pdfLocatorCoverage(wanted, actual) {
  if (!wanted.length) return 0;
  return wanted.filter(t => actual.some(a => a === t ||
    (/^[a-z]+$/.test(t) && /^[a-z]+$/.test(a) && Math.min(t.length, a.length) >= 4 &&
      (t.startsWith(a) || a.startsWith(t))))).length / wanted.length;
}
function pdfLocatorTextBoxes(content, viewport) {
  const boxes = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim() || !item.transform || !(item.width > 0)) continue;
    const [a,b,c,d,e,f] = item.transform;
    const along = Math.hypot(a,b), up = Math.hypot(c,d);
    if (!along || !up) continue;
    const style = (content.styles || {})[item.fontName] || {};
    const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.85;
    const descent = Number.isFinite(style.descent) ? style.descent : -0.2;
    const points = [];
    for (const length of [0,item.width]) for (const height of [descent,ascent]) {
      points.push(viewport.convertToViewportPoint(
        e + a / along * length + c * height,
        f + b / along * length + d * height));
    }
    const xs = points.map(p => p[0] / viewport.width);
    const ys = points.map(p => p[1] / viewport.height);
    const left = Math.max(0, Math.min(...xs)), top = Math.max(0, Math.min(...ys));
    const right = Math.min(1, Math.max(...xs)), bottom = Math.min(1, Math.max(...ys));
    if (right > left && bottom > top) boxes.push({ text: item.str, x: left, y: top, w: right-left, h: bottom-top });
  }
  return boxes;
}
function pdfLocatorRows(boxes) {
  const rows = [];
  for (const box of [...boxes].sort((a,b) => a.y - b.y || a.x - b.x)) {
    const center = box.y + box.h/2;
    const row = rows.find(r => Math.abs(r.center - center) <= Math.min(r.height,box.h) * 0.45);
    if (row) row.boxes.push(box);
    else rows.push({ center, height: box.h, boxes: [box] });
  }
  return rows.sort((a,b) => a.center-b.center).map(row => {
    row.boxes.sort((a,b) => a.x-b.x);
    const x = Math.min(...row.boxes.map(b => b.x)), y = Math.min(...row.boxes.map(b => b.y));
    const right = Math.max(...row.boxes.map(b => b.x+b.w)), bottom = Math.max(...row.boxes.map(b => b.y+b.h));
    return { text: row.boxes.map(b => b.text).join(" "), x,y,w:right-x,h:bottom-y };
  });
}
function locatePdfLine(pages, line) {
  const wanted = [...new Set(pdfLocatorTokens(line.description))];
  if (!wanted.length) return null;
  const numeric = wanted.filter(t => /^\d+$/.test(t));
  const words = wanted.filter(t => !/^\d+$/.test(t));
  if (!words.length) return null;
  const total = line.total == null ? NaN : Number(line.total);
  const candidates = [];
  for (const page of pages) {
    const rows = page.rows;
    for (let i=0; i<rows.length; i++) {
      let text = "", selected = [];
      for (let n=0; n<4 && i+n<rows.length; n++) {
        const row = rows[i+n];
        // Do not cross a printed price row into the next item, or a large gap.
        if (n && (pdfLocatorAmounts(rows[i+n-1].text).length ||
          row.y - (rows[i+n-1].y + rows[i+n-1].h) > Math.max(row.h,rows[i+n-1].h)*1.5)) break;
        selected.push(row); text += " " + row.text;
        const tokens = pdfLocatorTokens(text);
        const coverage = pdfLocatorCoverage(words,tokens);
        if (coverage < 0.7 || numeric.some(t => !tokens.includes(t))) continue;
        const amounts = pdfLocatorAmounts(text);
        const amountMatch = Number.isFinite(total) && amounts.some(a => Math.abs(a-total) < 0.011);
        // A weak/short description needs exact financial corroboration.
        if ((!amountMatch && (words.length < 3 || coverage < 0.9)) ||
          (Number.isFinite(total) && amounts.length && !amountMatch)) continue;
        const before = pdfLocatorTokens(rows.slice(Math.max(0,i-1),i).map(r => r.text).join(" "));
        const after = pdfLocatorTokens(rows.slice(i+n+1,i+n+2).map(r => r.text).join(" "));
        const context = (pdfLocatorCoverage(pdfLocatorTokens(line.previousDescription),before) +
          pdfLocatorCoverage(pdfLocatorTokens(line.nextDescription),after));
        const x = Math.min(...selected.map(r=>r.x)), y = Math.min(...selected.map(r=>r.y));
        const right = Math.max(...selected.map(r=>r.x+r.w)), bottom = Math.max(...selected.map(r=>r.y+r.h));
        candidates.push({ page: page.pageNumber, start:i, end:i+n,
          score:coverage + (amountMatch ? 0.35 : 0) + context*0.3 - n*0.025,
          bbox:{x,y,w:right-x,h:bottom-y} });
      }
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  const best = candidates[0];
  if (!best) return null;
  // Overlapping windows describe the same physical row. Other plausible
  // rows must lose by a clear margin; a page hint cannot break a tie.
  const rival = candidates.find(c => c.page !== best.page || c.end < best.start || c.start > best.end);
  if (rival && best.score-rival.score < 0.18) return null;
  return { page:best.page, bbox:best.bbox };
}
`;
