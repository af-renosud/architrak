/**
 * Client-facing page for a sealed worksheet copy (English, read-only, with
 * optional comments). Rendered from the frozen payload served by `dataUrl`.
 * Preview mode (architect) disables commenting and shows a banner.
 */
export function renderWorksheetShareShell(opts: { dataUrl: string; commentUrl: string | null; backUrl: string; preview: boolean }): string {
  const banner = opts.preview
    ? `<div class="preview-banner" data-testid="banner-worksheet-preview">Architect preview — this is what the client will see. Comments are disabled here.</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Agreed changes — Renosud</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  header { background: #0B2545; color: #fff; padding: 16px 24px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .meta { font-size: 13px; opacity: 0.85; margin-top: 4px; }
  main { max-width: 1080px; margin: 0 auto; padding: 24px; padding-bottom: 60px; }
  a.back { font-size: 13px; color: #2563eb; text-decoration: none; }
  .note { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin: 12px 0; font-size: 13px; color: #334155; }
  .warn { background: #fef3c7; border-color: #fde68a; color: #92400e; }
  .kpis { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
  .kpi { flex: 1 1 200px; background: #fff; border: 1px solid #e2e8f0; border-top: 3px solid #0B2545; border-radius: 6px; padding: 10px 12px; }
  .kpi .l { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #64748b; }
  .kpi .v { font-size: 18px; font-weight: 800; margin-top: 4px; white-space: nowrap; }
  .kpi .s { font-size: 11px; color: #64748b; margin-top: 2px; }
  .table-wrap { overflow-x: auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #1e293b; color: #fff; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; padding: 8px 6px; }
  td { border-top: 1px solid #e2e8f0; padding: 6px; vertical-align: top; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.lot td { background: #e2e8f0; font-weight: 700; }
  tr.sub td { background: #f8fafc; font-weight: 600; }
  .orig { color: #64748b; font-style: italic; display: block; margin-top: 2px; }
  .line-note { color: #334155; display: block; margin-top: 2px; }
  .st { display: inline-block; border-radius: 9999px; padding: 1px 8px; font-size: 10px; font-weight: 600; border: 1px solid; white-space: nowrap; }
  .st-Unchanged { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }
  .st-Modified { background: #fffbeb; color: #92400e; border-color: #fde68a; }
  .st-Removed { background: #fff1f2; color: #be123c; border-color: #fecdd3; }
  .st-Added { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
  .st-Not-priced { background: #f5f3ff; color: #6d28d9; border-color: #ddd6fe; }
  .removed td.desc { text-decoration: line-through; color: #64748b; }
  .comments { margin-top: 24px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
  .comments h2 { font-size: 14px; margin: 0 0 8px; }
  .comment { border-top: 1px solid #e2e8f0; padding: 8px 0; font-size: 13px; white-space: pre-wrap; }
  .comment .who { font-size: 11px; color: #64748b; }
  textarea { width: 100%; box-sizing: border-box; min-height: 80px; font: inherit; font-size: 13px; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; }
  button { background: #0B2545; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-weight: 600; cursor: pointer; margin-top: 8px; }
  button:disabled { opacity: .5; cursor: default; }
  .preview-banner { background: #fef3c7; color: #92400e; font-size: 13px; font-weight: 600; padding: 8px 24px; border-bottom: 1px solid #fde68a; }
  .empty { color: #64748b; font-style: italic; padding: 32px; text-align: center; }
</style>
</head>
<body>
${banner}<header><h1>Agreed changes — Renosud</h1><div class="meta" id="meta">Loading…</div></header>
<main id="root"><div class="empty">Loading…</div></main>
<script>
const DATA_URL = ${JSON.stringify(opts.dataUrl)};
const COMMENT_URL = ${JSON.stringify(opts.commentUrl)};
const BACK_URL = ${JSON.stringify(opts.backUrl)};
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function money(c) { if (c == null) return "Not priced"; return new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c / 100) + " €"; }
function signed(c) { if (c == null) return ""; return (c > 0 ? "+" : "") + money(c); }
function num(v) { if (v == null) return "—"; return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 }).format(Number(v)); }
function price(v) { if (v == null) return "—"; return new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v)) + " €"; }
function date(v) { return new Date(v).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "Europe/Paris" }); }
function dateTime(v) { return new Date(v).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" }); }

function render(data) {
  const w = data.worksheet;
  document.getElementById("meta").textContent = w.projectName;
  let html = '<a class="back" href="' + esc(BACK_URL) + '">&larr; Back to your project</a>';
  html += '<h2 style="margin:12px 0 4px" data-testid="text-worksheet-title">' + esc(w.title) + '</h2>';
  html += '<p style="margin:0;font-size:13px;color:#475569">' + esc(w.quotation.contractorName) + ' · quotation ' + esc(w.quotation.documentRef || w.quotation.ref)
    + (w.meetingDate ? ' · meeting of ' + esc(date(w.meetingDate)) : '') + ' · shared ' + esc(dateTime(data.sealedAt)) + '</p>';
  if (data.superseded) html += '<div class="note warn" data-testid="text-worksheet-superseded">A newer version of these agreed changes has been shared. Go back to your project to open it.</div>';
  html += '<div class="note">This is a fixed copy of the changes agreed in the meeting. It does not change the contractor\\'s quotation: a revised quotation will be requested and sent to you for signature. Amounts excl. VAT unless stated.'
    + (w.language === "english" ? '' : w.language === "partial" ? ' Some lines are shown in the contractor\\'s original French wording.' : ' Lines are shown in the contractor\\'s original French wording.') + '</div>';
  html += '<div class="kpis">'
    + '<div class="kpi" data-testid="kpi-original"><div class="l">Original quotation</div><div class="v">' + money(w.original.ttcCents) + '</div><div class="s">incl. VAT · ' + money(w.original.htCents) + ' excl. VAT</div></div>'
    + '<div class="kpi" data-testid="kpi-revised"><div class="l">With agreed changes</div><div class="v">' + money(w.revised.ttcCents) + '</div><div class="s">incl. VAT · ' + money(w.revised.htCents) + ' excl. VAT</div></div>'
    + '<div class="kpi" data-testid="kpi-difference"><div class="l">Difference</div><div class="v">' + signed(w.revised.ttcCents - w.original.ttcCents) + '</div><div class="s">incl. VAT · ' + signed(w.revised.htCents - w.original.htCents) + ' excl. VAT</div></div>'
    + (w.revised.depositCents != null ? '<div class="kpi"><div class="l">Deposit (' + esc(num(w.depositPercent)) + '%)</div><div class="v">' + money(w.revised.depositCents) + '</div><div class="s">incl. VAT, on the revised total</div></div>' : '')
    + '</div>';
  if (w.unknownVatLineCount > 0) html += '<div class="note warn">' + w.unknownVatLineCount + ' line(s) have no VAT rate yet; VAT totals exclude them.</div>';
  html += '<div class="table-wrap"><table data-testid="table-shared-worksheet"><thead><tr><th>Item</th><th>Description</th><th>Unit</th><th class="n">Orig. qty</th><th class="n">Orig. unit</th><th class="n">Orig. total</th><th class="n">New qty</th><th class="n">New unit</th><th class="n">New total</th><th class="n">Difference</th><th>Status</th></tr></thead><tbody>';
  w.lots.forEach(function (lot) {
    html += '<tr class="lot"><td colspan="11">' + esc(lot.label) + '</td></tr>';
    lot.lines.forEach(function (l) {
      html += '<tr class="' + (l.status === "Removed" ? 'removed' : '') + '"><td>' + esc(l.item) + '</td><td class="desc">' + esc(l.description)
        + (l.originalDescription ? '<span class="orig">' + esc(l.originalDescription) + '</span>' : '')
        + (l.note ? '<span class="line-note">Note: ' + esc(l.note) + '</span>' : '')
        + (l.tag ? '<span class="line-note">' + esc(l.tag) + '</span>' : '') + '</td>'
        + '<td>' + esc(l.unit || '') + '</td><td class="n">' + num(l.originalQuantity) + '</td><td class="n">' + price(l.originalUnitPrice) + '</td>'
        + '<td class="n">' + (l.originalCents == null ? '—' : money(l.originalCents)) + '</td><td class="n">' + num(l.revisedQuantity) + '</td>'
        + '<td class="n">' + price(l.revisedUnitPrice) + '</td><td class="n">' + money(l.revisedCents) + '</td><td class="n">' + signed(l.differenceCents) + '</td>'
        + '<td><span class="st st-' + esc(l.status.replace(" ", "-")) + '">' + esc(l.status) + '</span></td></tr>';
    });
    html += '<tr class="sub"><td></td><td colspan="4">Subtotal — ' + esc(lot.label) + '</td><td class="n">' + money(lot.originalHtCents) + '</td><td colspan="2"></td><td class="n">' + money(lot.revisedHtCents) + '</td><td class="n">' + signed(lot.revisedHtCents - lot.originalHtCents) + '</td><td></td></tr>';
  });
  html += '</tbody></table></div>';
  html += '<section class="comments" data-testid="section-worksheet-comments"><h2>Comments for your architect</h2>';
  if (!data.comments.length) html += '<p style="font-size:13px;color:#64748b;margin:0 0 8px">No comments yet.</p>';
  data.comments.forEach(function (c) {
    html += '<div class="comment" data-testid="comment-' + c.id + '"><div class="who">' + esc(c.authorName || "You") + ' · ' + esc(dateTime(c.createdAt)) + '</div>' + esc(c.body) + '</div>';
  });
  if (COMMENT_URL && !data.superseded) {
    html += '<form id="comment-form"><textarea id="comment-body" maxlength="5000" placeholder="Optional: questions or remarks about these changes" data-testid="input-worksheet-comment"></textarea>'
      + '<button type="submit" id="comment-submit" data-testid="button-worksheet-comment">Send comment</button> <span id="comment-msg" style="font-size:12px;color:#64748b"></span></form>';
  } else if (!COMMENT_URL) {
    html += '<p style="font-size:12px;color:#64748b">Comments are disabled in the preview.</p>';
  }
  html += '</section>';
  document.getElementById("root").innerHTML = html;
  const form = document.getElementById("comment-form");
  if (form) form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const body = document.getElementById("comment-body").value.trim();
    const msg = document.getElementById("comment-msg");
    if (!body) { msg.textContent = "Write a comment first."; return; }
    const btn = document.getElementById("comment-submit");
    btn.disabled = true; msg.textContent = "Sending…";
    try {
      const r = await fetch(COMMENT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: body }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = j.message || "Your comment could not be sent. Please try again."; btn.disabled = false; return; }
      load();
    } catch (_e) { msg.textContent = "Network error. Please try again."; btn.disabled = false; }
  });
}

async function load() {
  const root = document.getElementById("root");
  let r;
  try { r = await fetch(DATA_URL); } catch (_e) { root.innerHTML = '<div class="empty">Network error. Please try again.</div>'; return; }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    root.innerHTML = '<div class="empty">' + esc(j.message || "This page is no longer available.") + '</div>';
    return;
  }
  render(await r.json());
}
load();
</script>
</body>
</html>`;
}
