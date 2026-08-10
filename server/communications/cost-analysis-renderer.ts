import type { AnalysisBlock, AnalysisInline, CostAnalysisDocument } from "@shared/cost-analysis-doc";

/**
 * Safe HTML serializer for the cost-analysis appendix AST (Task #378).
 * Whitelist-based like context-doc-renderer: only headings, paragraphs,
 * bold/italic text and tables exist in the AST; every text node is escaped;
 * there are no links, images, or external fetches by construction.
 *
 * CSS is Prince-safe: tables and plain block flow only — PrinceXML ignores
 * display:grid (renders stacked), so grid is never used here.
 */

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(content: AnalysisInline[]): string {
  return content
    .map((n) => {
      let html = escapeHtml(n.text);
      if (n.bold) html = `<strong>${html}</strong>`;
      if (n.italic) html = `<em>${html}</em>`;
      return html;
    })
    .join("");
}

function renderBlock(block: AnalysisBlock): string {
  switch (block.type) {
    case "heading":
      return block.level === 2
        ? `<h2 class="ca-h2">${renderInline(block.content)}</h2>`
        : `<h3 class="ca-h3">${renderInline(block.content)}</h3>`;
    case "paragraph":
      return `<p class="ca-p">${renderInline(block.content)}</p>`;
    case "table": {
      const head = block.header.map((c) => `<th>${renderInline(c)}</th>`).join("");
      const body = block.rows
        .map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
        .join("");
      return `<table class="ca-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
  }
}

export function renderCostAnalysisHtml(doc: CostAnalysisDocument): string {
  return doc.blocks.map(renderBlock).join("\n");
}

export const COST_ANALYSIS_PDF_CSS = `
.ca-section { break-before: page; }
.ca-section .ca-header { border-bottom: 2px solid #0B2545; padding-bottom: 4mm; margin-bottom: 5mm; }
.ca-section .ca-title { font-size: 13pt; font-weight: 800; color: #0B2545; text-transform: uppercase; letter-spacing: 0.05em; }
.ca-section .ca-subtitle { font-size: 8.5pt; color: #7E7F83; margin-top: 1.5mm; }
.ca-h2 { font-size: 10.5pt; color: #0B2545; margin: 5mm 0 2mm; text-transform: uppercase; letter-spacing: 0.04em; }
.ca-h3 { font-size: 9.5pt; color: #0B2545; margin: 4mm 0 1.5mm; }
.ca-p { font-size: 8.5pt; margin: 1.5mm 0; line-height: 1.45; }
.ca-table { width: 100%; border-collapse: collapse; margin: 2mm 0 4mm; }
.ca-table thead th { background: #0B2545; color: #FFF; font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 4px 6px; text-align: left; }
.ca-table tbody td { padding: 4px 6px; border-bottom: 1px solid #E6E6E6; vertical-align: top; font-size: 8pt; }
.ca-table tbody tr:nth-child(even) td { background: #FAFAFA; }
.ca-disclaimer { background: #FFF9F0; border: 1px solid #C1A27B; padding: 3mm; margin-top: 4mm; font-size: 7.5pt; color: #6B5B3E; border-radius: 2px; }
`;
