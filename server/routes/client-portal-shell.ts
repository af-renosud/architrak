/**
 * Client portal HTML shell (Task #389 redesign) — split out of
 * public-client-checks.ts to keep routes and template separate without
 * introducing a second React build. Vanilla server-rendered shell, English
 * copy (Renosud's clients are English speakers).
 *
 * Two modes share the template:
 *   • live: token-authed client portal (writes enabled).
 *   • preview: architect-authed read-only preview served inside an iframe
 *     in the architect UI. Forms are suppressed and a banner identifies it.
 *
 * Redesign notes (user decisions, Task #389):
 *   • The Approve/Decline verdict cards are GONE — agreement happens through
 *     dialogue plus the e-signature workflow. Historical verdict rows are
 *     still rendered as badges (audit trail), but no new ones can be minted.
 *   • The full bilingual quotation is shown inline: per-line English
 *     translations (finalised translations only), per-line contextual notes
 *     (pre-rendered safe HTML from the whitelisting serializer), and the
 *     confirmed, non-stale cost analysis.
 *   • "Download complete package" serves the combined EN+FR PDF.
 *   • Per-line and per-quotation "Ask about this" entry points feed the
 *     dialogue; highlight-text → "Research" opens a Google search client-side
 *     (nothing is sent or stored server-side).
 */

export function renderClientInvalid(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invalid link</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1f2937}</style>
</head><body data-testid="page-client-invalid"><h1>Invalid link</h1>
<p>This link is no longer valid. Please contact your Renosud representative to obtain a new link.</p>
</body></html>`;
}

export function renderClientExpired(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Link expired</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#0f172a;line-height:1.5}
h1{font-size:22px;margin:0 0 12px;color:#b45309}
.note{background:#fef3c7;border-left:3px solid #f59e0b;padding:12px 16px;border-radius:4px;margin:16px 0}
p{margin:8px 0}
</style>
</head><body data-testid="page-client-expired">
<h1>Link expired</h1>
<div class="note">This client review portal link has expired for security reasons.</div>
<p>To resume reviewing this devis, please contact your Renosud representative (the architect who sent you this link). They can generate a new access link for you.</p>
<p>Your previous messages and decisions are kept and remain available to the Renosud team.</p>
</body></html>`;
}

export function renderClientPortalShell(opts:
  | { mode: "live"; token: string }
  | { mode: "preview"; devisId: number }
): string {
  const isPreview = opts.mode === "preview";
  const dataUrl = opts.mode === "preview"
    ? `/api/devis/${opts.devisId}/client-checks/portal-preview/data`
    : `/p/client/${encodeURIComponent(opts.token)}/data`;
  const pdfUrl = opts.mode === "preview"
    ? `/api/devis/${opts.devisId}/client-checks/portal-preview/pdf`
    : `/p/client/${encodeURIComponent(opts.token)}/pdf`;
  const packageUrl = opts.mode === "preview"
    ? `/api/devis/${opts.devisId}/client-checks/portal-preview/package.pdf`
    : `/p/client/${encodeURIComponent(opts.token)}/package.pdf`;
  const messagesUrl = opts.mode === "preview" ? null : `/p/client/${encodeURIComponent(opts.token)}/messages`;
  const queriesUrl = opts.mode === "preview" ? null : `/p/client/${encodeURIComponent(opts.token)}/queries`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${isPreview ? "Architect preview — " : ""}Client portal — Renosud</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  .preview-banner { background: #fef3c7; color: #78350f; border-bottom: 2px solid #f59e0b; padding: 8px 16px; font-size: 12px; font-weight: 600; text-align: center; letter-spacing: 0.02em; }
  header { background: #0B2545; color: #fff; padding: 16px 24px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .meta { font-size: 13px; opacity: 0.85; margin-top: 4px; }
  main { max-width: 960px; margin: 0 auto; padding: 24px; padding-bottom: 80px; }
  .devis-info { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .devis-info h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; color: #0f172a; }
  .devis-desc { margin: 0 0 6px; font-size: 13px; color: #334155; line-height: 1.5; }
  .devis-desc-en { color: #64748b; }
  .devis-total { margin: 8px 0 12px; font-size: 13px; color: #0f172a; }
  .devis-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 12px; align-items: center; }
  .devis-actions .hint { font-size: 12px; color: #64748b; }
  .devis-lines { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  .devis-lines th, .devis-lines td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; vertical-align: top; }
  .devis-lines th { background: #f1f5f9; font-weight: 600; color: #475569; }
  .devis-lines td.amount, .devis-lines th.amount { text-align: right; white-space: nowrap; }
  .line-en { color: #1d4ed8; font-style: italic; margin-top: 4px; font-size: 12px; }
  .line-actions { margin-top: 6px; }
  .btn-ask-line { background: #fff; color: #0B2545; border: 1px solid #cbd5e1; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  .btn-ask-line:hover { border-color: #0B2545; }
  .ctx-sub { background: #FBF8F3; border-left: 3px solid #C1A27B; }
  .ctx-sub .ctx-lbl { font-size: 10px; text-transform: uppercase; color: #7E7F83; letter-spacing: 0.08em; margin-bottom: 4px; }
  .ctx-sub p { margin: 0 0 6px; }
  .ctx-sub ul, .ctx-sub ol { margin: 0 0 6px; padding-left: 18px; }
  .ctx-sub img { max-width: 320px; max-height: 240px; border: 1px solid #E6E6E6; display: block; margin: 6px 0; }
  .ctx-sub a { color: #0B2545; }
  .analysis { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .analysis h3 { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #0B2545; text-transform: uppercase; letter-spacing: 0.03em; }
  .analysis .ca-h2 { font-size: 13px; color: #0B2545; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0.03em; }
  .analysis .ca-h3 { font-size: 13px; color: #0B2545; margin: 10px 0 4px; }
  .analysis .ca-p { font-size: 13px; margin: 6px 0; line-height: 1.5; }
  .analysis .ca-table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; font-size: 12px; }
  .analysis .ca-table thead th { background: #0B2545; color: #FFF; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; padding: 5px 7px; text-align: left; }
  .analysis .ca-table tbody td { padding: 5px 7px; border-bottom: 1px solid #E6E6E6; vertical-align: top; }
  .analysis .ca-table tbody tr:nth-child(even) td { background: #FAFAFA; }
  .analysis .ca-disclaimer { background: #FFF9F0; border: 1px solid #C1A27B; padding: 10px 12px; margin-top: 12px; font-size: 12px; color: #6B5B3E; border-radius: 4px; }
  .check { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 16px; padding: 16px; }
  .check.verdict-agree { border-left: 4px solid #059669; }
  .check.verdict-reject { border-left: 4px solid #dc2626; }
  .check h3 { margin: 0 0 8px; font-size: 14px; color: #475569; font-weight: 600; }
  .query { background: #fef3c7; border-left: 3px solid #f59e0b; padding: 8px 12px; margin: 0 0 12px; font-size: 14px; }
  .line-badge { display: inline-block; background: #e0e7ff; color: #3730a3; border-radius: 9999px; padding: 2px 10px; font-size: 11px; font-weight: 600; margin: 0 0 8px 0; }
  .verdict-tag { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 8px; }
  .verdict-tag.agree { background: #d1fae5; color: #065f46; }
  .verdict-tag.reject { background: #fee2e2; color: #991b1b; }
  .status { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 9999px; margin-left: 8px; }
  .status-open { background: #fee2e2; color: #991b1b; }
  .status-resolved { background: #dcfce7; color: #166534; }
  .status-cancelled { background: #f1f5f9; color: #64748b; }
  .messages { margin: 12px 0; }
  .msg { padding: 8px 12px; margin: 6px 0; border-radius: 6px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; }
  .msg-architect { background: #f1f5f9; }
  .msg-client { background: #eff6ff; }
  .msg-system { background: #fefce8; color: #78350f; font-style: italic; font-size: 13px; }
  .msg-meta { font-size: 11px; color: #64748b; margin-bottom: 2px; font-style: normal; }
  textarea { width: 100%; min-height: 70px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 4px; padding: 8px; font: inherit; resize: vertical; }
  button { background: #0B2545; color: #fff; border: 0; border-radius: 4px; padding: 8px 14px; font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.btn-secondary { background: #fff; color: #0B2545; border: 1px solid #0B2545; }
  a.btn-download { display: inline-block; background: #0B2545; color: #fff; border-radius: 4px; padding: 8px 14px; font-size: 13px; text-decoration: none; }
  .ask-section { background: #fff; border: 1px dashed #94a3b8; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .ask-section h3 { margin: 0 0 8px; font-size: 14px; }
  .ask-section .hint { font-size: 12px; color: #64748b; margin: 0 0 8px; }
  .ask-line-chip { display: none; align-items: center; gap: 8px; background: #e0e7ff; color: #3730a3; border-radius: 9999px; padding: 4px 12px; font-size: 12px; font-weight: 600; margin: 0 0 8px 0; }
  .ask-line-chip.visible { display: inline-flex; }
  .ask-line-chip button { background: transparent; color: #3730a3; padding: 0 2px; font-size: 14px; line-height: 1; }
  .dialogue-note { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; color: #075985; line-height: 1.5; }
  .pdf-toggle { position: fixed; bottom: 20px; right: 20px; z-index: 9; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
  .pdf-panel { position: fixed; bottom: 80px; right: 20px; width: 480px; height: 640px; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 12px 32px rgba(0,0,0,0.2); display: none; flex-direction: column; z-index: 10; }
  .pdf-panel.open { display: flex; }
  .pdf-handle { padding: 8px 12px; background: #0B2545; color: #fff; cursor: move; user-select: none; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  .pdf-handle button { background: transparent; padding: 2px 8px; }
  .pdf-frame { flex: 1; border: 0; border-radius: 0 0 8px 8px; }
  .pdf-resize { position: absolute; bottom: 2px; right: 2px; width: 14px; height: 14px; cursor: nwse-resize; opacity: 0.5; z-index: 2; }
  .empty { color: #64748b; font-style: italic; padding: 24px; text-align: center; }
  .err { color: #b91c1c; font-size: 13px; margin-top: 6px; }
  .research-btn { position: absolute; z-index: 20; background: #0B2545; color: #fff; border: 0; border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.25); display: none; }
  .research-btn.visible { display: block; }
</style>
</head>
<body${isPreview ? ` data-preview="1"` : ""}>
${isPreview ? `<div class="preview-banner" data-testid="banner-client-preview">Architect preview — actions will not be sent.</div>` : ""}
<header>
  <h1>Client portal — Renosud</h1>
  <div class="meta" id="meta">Loading…</div>
</header>
<main id="root"><div class="empty">Loading…</div></main>

<button class="research-btn" id="researchBtn" type="button" data-testid="button-research">Research&nbsp;↗</button>

<button class="pdf-toggle" id="pdfToggle" type="button" data-testid="button-client-pdf-toggle">View the devis (PDF)</button>
<div class="pdf-panel" id="pdfPanel">
  <div class="pdf-handle" id="pdfHandle">
    <span>Devis — PDF</span>
    <button id="pdfClose" type="button" aria-label="Close">×</button>
  </div>
  <iframe id="pdfFrame" class="pdf-frame" title="Devis PDF" src="about:blank" data-testid="iframe-client-pdf"></iframe>
  <div class="pdf-resize" id="pdfResize"></div>
</div>

<script>
const DATA_URL = ${JSON.stringify(dataUrl)};
const PDF_URL = ${JSON.stringify(pdfUrl)};
const PACKAGE_URL = ${JSON.stringify(packageUrl)};
const MESSAGES_URL = ${messagesUrl === null ? "null" : JSON.stringify(messagesUrl)};
const QUERIES_URL = ${queriesUrl === null ? "null" : JSON.stringify(queriesUrl)};
const PREVIEW_MODE = ${isPreview ? "true" : "false"};
const STATUS_LABELS = {
  open: "Open",
  resolved: "Closed",
  cancelled: "Cancelled",
};

// Line item id currently attached to the "Ask a question" form (null =
// quotation-level question). Set by the per-line "Ask about this" buttons.
let askLineItemId = null;
let lineLabelById = {};

async function loadData() {
  const r = await fetch(DATA_URL);
  if (r.status === 410) {
    const j = await r.json().catch(() => ({}));
    document.getElementById("root").innerHTML =
      '<div class="empty" data-testid="text-client-expired">' +
      escapeHtml(j.message || "This link has expired. Please contact your Renosud representative.") +
      '</div>';
    return null;
  }
  if (!r.ok) {
    document.getElementById("root").innerHTML = '<div class="empty">Invalid or expired link.</div>';
    return null;
  }
  return r.json();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function render(data) {
  const meta = document.getElementById("meta");
  const subject = (data.project && data.project.name) ? (data.project.name + " — devis " + (data.devis.ref || "")) : ("devis " + (data.devis.ref || ""));
  meta.textContent = subject;
  const root = document.getElementById("root");

  lineLabelById = {};
  (data.lineItems || []).forEach((li) => {
    const desc = (li.description || "").slice(0, 60);
    lineLabelById[li.id] = "Line " + (li.lineNumber != null ? li.lineNumber : "?") + (desc ? " — " + desc : "");
  });

  const devisInfo = renderDevisInfo(data);
  const analysisBlock = renderAnalysis(data);
  const dialogueNote = renderDialogueNote();
  const askBlock = PREVIEW_MODE ? renderAskBlockPreview() : renderAskBlock();
  const checksBlock = data.checks.length ? data.checks.map(renderCheck).join("") : '<div class="empty" data-testid="text-no-checks">No questions yet.</div>';

  root.innerHTML = devisInfo + analysisBlock + dialogueNote + askBlock + checksBlock;

  if (!PREVIEW_MODE) {
    wireAskForm();
    wireReplyForms();
    wireAskLineButtons();
  }
}

function renderDevisInfo(data) {
  // Full bilingual summary card: project / ref, FR + EN descriptions,
  // total HT, line items with English translations and contextual notes,
  // and the complete-package download.
  const d = data.devis || {};
  const titleBits = [d.ref ? 'Devis ' + escapeHtml(d.ref) : null].filter(Boolean);
  const title = titleBits.length ? '<h3 data-testid="text-devis-ref">' + titleBits.join(' — ') + '</h3>' : '';
  const descFr = d.description ? '<p class="devis-desc" data-testid="text-devis-description-fr">' + escapeHtml(d.description) + '</p>' : '';
  const descEn = d.descriptionEn ? '<p class="devis-desc devis-desc-en" data-testid="text-devis-description-en"><em>' + escapeHtml(d.descriptionEn) + '</em></p>' : '';
  const scopeEn = data.translationHeaderEn ? '<p class="devis-desc devis-desc-en" data-testid="text-devis-scope-en"><em>' + escapeHtml(data.translationHeaderEn) + '</em></p>' : '';
  const summary = data.translationSummary ? '<p class="devis-desc" data-testid="text-devis-summary">' + escapeHtml(data.translationSummary) + '</p>' : '';
  const total = d.amountHt ? '<p class="devis-total" data-testid="text-devis-amount-ht"><strong>Amount HT:</strong> ' + escapeHtml(d.amountHt) + ' €</p>' : '';
  const pkg = data.packageAvailable
    ? '<div class="devis-actions"><a class="btn-download" href="' + PACKAGE_URL + '" target="_blank" rel="noopener" data-testid="link-download-package">Download the complete package (PDF)</a>'
      + '<span class="hint">English translation, contextual notes and value analysis, followed by the original French devis.</span></div>'
    : '';
  const items = Array.isArray(data.lineItems) ? data.lineItems : [];
  const hasEn = items.some((li) => li.translationEn);
  const itemsBlock = items.length
    ? '<table class="devis-lines" data-testid="table-devis-line-items">'
      + '<thead><tr><th>No.</th><th>Description' + (hasEn ? ' (FR / EN)' : '') + '</th><th class="amount">Qty</th><th>Unit</th><th class="amount">Unit price HT</th><th class="amount">Total HT</th></tr></thead>'
      + '<tbody>'
      + items.map((li) => {
          const askBtn = PREVIEW_MODE
            ? ''
            : '<div class="line-actions"><button type="button" class="btn-ask-line" data-line-id="' + li.id + '" data-testid="button-ask-line-' + li.id + '">Ask about this</button></div>';
          const en = li.translationEn ? '<div class="line-en" data-testid="text-line-en-' + li.id + '">' + escapeHtml(li.translationEn) + '</div>' : '';
          const main = '<tr data-testid="row-line-item-' + li.id + '">'
            + '<td>' + escapeHtml(li.lineNumber || '') + '</td>'
            + '<td>' + escapeHtml(li.description || '') + en + askBtn + '</td>'
            + '<td class="amount">' + escapeHtml(li.quantity || '') + '</td>'
            + '<td>' + escapeHtml(li.unit || '') + '</td>'
            + '<td class="amount">' + escapeHtml(li.unitPrice || '') + '</td>'
            + '<td class="amount">' + escapeHtml(li.totalHt || '') + '</td>'
            + '</tr>';
          // contextHtml is pre-rendered server-side by the whitelisting
          // serializer from a validated document (same renderer as the PDF)
          // — it is the one deliberate non-escaped interpolation here.
          const ctx = li.contextHtml
            ? '<tr class="ctx-sub" data-testid="row-line-context-' + li.id + '"><td></td><td colspan="5"><div class="ctx-lbl">Note from your architect</div>' + li.contextHtml + '</td></tr>'
            : '';
          return main + ctx;
        }).join('')
      + '</tbody></table>'
    : '';
  const inner = title + descFr + descEn + scopeEn + summary + total + pkg + itemsBlock;
  if (!inner) return '';
  return '<section class="devis-info" data-testid="section-devis-info">' + inner + '</section>';
}

function renderAnalysis(data) {
  if (!data.analysisHtml) return '';
  // analysisHtml is pre-rendered server-side by the whitelisting cost-
  // analysis serializer (escaped text nodes only) — safe to inject.
  return '<section class="analysis" data-testid="section-cost-analysis">'
    + '<h3>Cost analysis &amp; value engineering</h3>'
    + data.analysisHtml
    + '<div class="ca-disclaimer"><strong>Non-contractual analysis:</strong> this cost analysis is provided for information only and is not part of the contractual quotation. The original French devis remains the sole legally binding reference for scope, quantities and amounts.</div>'
    + '</section>';
}

function renderDialogueNote() {
  return '<div class="dialogue-note" data-testid="text-dialogue-note">'
    + 'Questions and comments are handled through the dialogue below — your architect replies here. '
    + 'When everything is agreed, the formal approval happens through the electronic signing workflow, not on this page. '
    + 'Tip: highlight any text on this page to research the term in a new tab.'
    + '</div>';
}

function renderAskBlock() {
  return '<div class="ask-section" data-testid="section-ask">'
    + '<h3>Ask a question</h3>'
    + '<p class="hint">Your architect will receive your question and reply in the thread below. Use “Ask about this” on a quotation line to reference it.</p>'
    + '<span class="ask-line-chip" id="askLineChip" data-testid="chip-ask-line"><span id="askLineChipLabel"></span><button type="button" id="askLineClear" aria-label="Remove line reference" data-testid="button-ask-line-clear">×</button></span>'
    + '<form id="askForm">'
    + '<textarea id="askBody" required maxlength="5000" placeholder="Your question…" data-testid="textarea-new-query"></textarea>'
    + '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;">'
    + '<button type="submit" data-testid="button-send-new-query">Send the question</button>'
    + '<span class="err" id="askErr"></span>'
    + '</div>'
    + '</form>'
    + '</div>';
}

function renderAskBlockPreview() {
  return '<div class="ask-section">'
    + '<h3>Ask a question</h3>'
    + '<p class="hint">Architect preview — form disabled.</p>'
    + '<textarea disabled placeholder="Your question…" data-testid="textarea-new-query-disabled"></textarea>'
    + '<div style="margin-top:8px"><button type="button" disabled data-testid="button-send-new-query-disabled">Send the question</button></div>'
    + '</div>';
}

function renderCheck(c) {
  // Historical verdict rows (minted by the retired Approve/Decline buttons)
  // remain rendered as audit badges; new ones can no longer be created.
  const verdictTag = c.verdict
    ? '<span class="verdict-tag ' + c.verdict + '" data-testid="tag-verdict-' + c.verdict + '-' + c.id + '">'
        + (c.verdict === 'agree' ? 'Client approval' : 'Client rejection') + '</span>'
    : '';
  const head = c.verdict
    ? verdictTag
    : '<h3>Question<span class="status status-' + c.status + '">' + (STATUS_LABELS[c.status] || c.status) + '</span></h3>';
  const lineBadge = (!c.verdict && c.devisLineItemId && lineLabelById[c.devisLineItemId])
    ? '<div><span class="line-badge" data-testid="badge-check-line-' + c.id + '">' + escapeHtml(lineLabelById[c.devisLineItemId]) + '</span></div>'
    : '';
  const queryBlock = c.verdict
    ? (c.query ? '<p class="query">' + escapeHtml(c.query) + '</p>' : '')
    : '<p class="query">' + escapeHtml(c.query) + '</p>';
  const msgs = c.messages.map((m) => {
    let author;
    if (m.authorType === 'client') author = m.authorName || 'You';
    else if (m.authorType === 'system') author = 'System';
    else author = 'Renosud';
    return '<div class="msg msg-' + m.authorType + '"><div class="msg-meta">' + escapeHtml(author) + '</div>' + escapeHtml(m.body) + '</div>';
  }).join('');
  const canReply = c.status === 'open' && !c.verdict && !PREVIEW_MODE;
  const replyForm = canReply
    ? '<form data-check="' + c.id + '" data-testid="form-reply-' + c.id + '"><textarea required maxlength="5000" data-testid="textarea-reply-' + c.id + '" placeholder="Your reply…"></textarea><div style="margin-top:8px;display:flex;gap:8px;align-items:center;"><button type="submit" data-testid="button-send-reply-' + c.id + '">Send</button><span class="err" data-err="' + c.id + '"></span></div></form>'
    : '';
  const cls = c.verdict ? 'check verdict-' + c.verdict : 'check';
  return '<section class="' + cls + '" data-testid="check-' + c.id + '">' + head + lineBadge
    + queryBlock
    + '<div class="messages">' + msgs + '</div>' + replyForm + '</section>';
}

function setAskLine(lineId) {
  askLineItemId = lineId;
  const chip = document.getElementById('askLineChip');
  const label = document.getElementById('askLineChipLabel');
  if (!chip || !label) return;
  if (lineId && lineLabelById[lineId]) {
    label.textContent = 'About: ' + lineLabelById[lineId];
    chip.classList.add('visible');
  } else {
    askLineItemId = null;
    chip.classList.remove('visible');
  }
}

function wireAskLineButtons() {
  document.querySelectorAll('.btn-ask-line').forEach((btn) => {
    btn.addEventListener('click', () => {
      setAskLine(Number(btn.getAttribute('data-line-id')));
      const section = document.querySelector('.ask-section');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const ta = document.getElementById('askBody');
      if (ta) ta.focus();
    });
  });
  const clear = document.getElementById('askLineClear');
  if (clear) clear.addEventListener('click', () => setAskLine(null));
}

function wireAskForm() {
  const form = document.getElementById('askForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ta = document.getElementById('askBody');
    const err = document.getElementById('askErr');
    err.textContent = '';
    const body = (ta.value || '').trim();
    if (!body) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const payload = { body };
      if (askLineItemId) payload.devisLineItemId = askLineItemId;
      const r = await fetch(QUERIES_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        err.textContent = j.message || 'Error while sending.';
      } else {
        ta.value = '';
        setAskLine(null);
        await refresh();
      }
    } catch (_e) {
      err.textContent = 'Network error.';
    } finally {
      btn.disabled = false;
    }
  });
}

function wireReplyForms() {
  document.querySelectorAll('form[data-check]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const checkId = Number(form.getAttribute('data-check'));
      const ta = form.querySelector('textarea');
      const errEl = form.querySelector('[data-err="' + checkId + '"]');
      if (errEl) errEl.textContent = '';
      const body = (ta.value || '').trim();
      if (!body) return;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const r = await fetch(MESSAGES_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkId, body }) });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          if (errEl) errEl.textContent = j.message || 'Error while sending.';
        } else {
          ta.value = '';
          await refresh();
        }
      } catch (_e) {
        if (errEl) errEl.textContent = 'Network error.';
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function refresh() {
  const data = await loadData();
  if (data) render(data);
}

// Highlight-text → "Research" button. Pure client-side: opens a Google
// search for the selection in a new tab (noopener); nothing is sent or
// stored server-side.
(function researchify() {
  const btn = document.getElementById('researchBtn');
  let currentText = '';
  function hide() { btn.classList.remove('visible'); currentText = ''; }
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel ? String(sel.toString() || '').trim() : '';
    if (!text || text.length < 2 || text.length > 400 || !sel.rangeCount) { hide(); return; }
    // Only offer research for selections inside the portal content.
    const main = document.getElementById('root');
    const anchor = sel.anchorNode;
    if (!main || !anchor || !main.contains(anchor.nodeType === 1 ? anchor : anchor.parentNode)) { hide(); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { hide(); return; }
    currentText = text;
    btn.style.left = (window.scrollX + rect.left + rect.width / 2 - 40) + 'px';
    btn.style.top = (window.scrollY + rect.top - 34) + 'px';
    btn.classList.add('visible');
  });
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (!currentText) return;
    window.open('https://www.google.com/search?q=' + encodeURIComponent(currentText), '_blank', 'noopener');
    hide();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  });
})();

// PDF panel — drag/resize/toggle. The client portal uses the browser's
// native PDF viewer in an iframe.
const panel = document.getElementById('pdfPanel');
const handle = document.getElementById('pdfHandle');
const toggle = document.getElementById('pdfToggle');
const closeBtn = document.getElementById('pdfClose');
const frame = document.getElementById('pdfFrame');
const resize = document.getElementById('pdfResize');
let pdfLoaded = false;

toggle.addEventListener('click', () => {
  panel.classList.toggle('open');
  if (panel.classList.contains('open') && !pdfLoaded) {
    frame.src = PDF_URL;
    pdfLoaded = true;
  }
});
closeBtn.addEventListener('click', () => panel.classList.remove('open'));

(function dragify() {
  let dragging = false; let dx = 0, dy = 0;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = (e.clientX - dx) + 'px';
    panel.style.top = (e.clientY - dy) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; });
})();

(function resizify() {
  let resizing = false;
  resize.addEventListener('mousedown', (e) => { resizing = true; e.preventDefault(); e.stopPropagation(); });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const r = panel.getBoundingClientRect();
    panel.style.width = Math.max(280, e.clientX - r.left) + 'px';
    panel.style.height = Math.max(240, e.clientY - r.top) + 'px';
  });
  window.addEventListener('mouseup', () => { resizing = false; });
})();

refresh();
</script>
</body>
</html>`;
}
