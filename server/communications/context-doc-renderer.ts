import type {
  ContextDoc,
  ContextBlockNode,
  ContextInlineNode,
  ContextListItemNode,
  ContextMark,
} from "@shared/context-doc";
import { isSafeContextHref } from "@shared/context-doc";

/**
 * Serializes a VALIDATED per-line context document (shared/context-doc.ts)
 * into HTML for the DocRaptor/PrinceXML translated-devis PDF.
 *
 * Safety model: this renderer never interpolates stored HTML. Every text
 * value and attribute is escaped; only whitelisted node/mark types are
 * emitted; link hrefs are re-checked against the https/mailto whitelist
 * even though the schema already enforces it (defense in depth). Image
 * nodes are resolved through `assetDataUris` — a map built by the caller
 * from OWNED assets only — so the document cannot reference foreign bytes;
 * unresolved ids render a neutral placeholder instead of failing the PDF.
 */

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTextWithMarks(text: string, marks: ContextMark[] | undefined): string {
  let html = escapeHtml(text);
  let link: string | null = null;
  for (const mark of marks ?? []) {
    if (mark.type === "bold") html = `<strong>${html}</strong>`;
    else if (mark.type === "italic") html = `<em>${html}</em>`;
    else if (mark.type === "link" && isSafeContextHref(mark.attrs.href)) link = mark.attrs.href;
  }
  if (link) {
    const href = escapeHtml(link);
    // Clickable in the PDF, with the URL printed visibly so a paper copy
    // still leads the reader to the external video/audio resource.
    const showUrl = text.trim() !== link.trim();
    html = `<a href="${href}" class="ctx-link">${html}</a>${showUrl ? ` <span class="ctx-url">(${href})</span>` : ""}`;
  }
  return html;
}

function renderInline(nodes: ContextInlineNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => (n.type === "hardBreak" ? "<br />" : renderTextWithMarks(n.text, n.marks)))
    .join("");
}

function renderListItems(items: ContextListItemNode[], assetDataUris: Map<number, string>): string {
  return items
    .map((item) => `<li>${item.content.map((c) => renderBlock(c as ContextBlockNode, assetDataUris)).join("")}</li>`)
    .join("");
}

function renderBlock(node: ContextBlockNode, assetDataUris: Map<number, string>): string {
  switch (node.type) {
    case "paragraph":
      return `<p>${renderInline(node.content)}</p>`;
    case "bulletList":
      return `<ul>${renderListItems(node.content, assetDataUris)}</ul>`;
    case "orderedList":
      return `<ol>${renderListItems(node.content, assetDataUris)}</ol>`;
    case "image": {
      const dataUri = assetDataUris.get(node.attrs.assetId);
      if (!dataUri || !dataUri.startsWith("data:image/")) {
        return `<p class="ctx-missing-img">[image unavailable]</p>`;
      }
      const alt = escapeHtml(node.attrs.alt ?? "");
      return `<div class="ctx-img-wrap"><img class="ctx-img" src="${dataUri}" alt="${alt}" /></div>`;
    }
    default:
      // Unknown node types are impossible post-validation; render nothing.
      return "";
  }
}

export function renderContextDocHtml(doc: ContextDoc, assetDataUris: Map<number, string>): string {
  return doc.content.map((n) => renderBlock(n, assetDataUris)).join("");
}

/**
 * CSS for context blocks in the translated-devis PDF. Images are hard
 * constrained so a large pasted photo cannot explode the landscape table
 * pagination; break-inside keeps an image from being split across pages.
 */
export const CONTEXT_DOC_PDF_CSS = `
.ctx-cell { background: #FBF8F3; border-left: 3px solid #C1A27B; }
.ctx-lbl { font-size: 6.5pt; text-transform: uppercase; color: #7E7F83; letter-spacing: 0.08em; margin-bottom: 1mm; }
.ctx-cell p { margin: 0 0 1.5mm 0; }
.ctx-cell ul, .ctx-cell ol { margin: 0 0 1.5mm 0; padding-left: 5mm; }
.ctx-link { color: #0B2545; text-decoration: underline; }
.ctx-url { color: #7E7F83; font-size: 7pt; word-break: break-all; }
.ctx-img-wrap { break-inside: avoid; margin: 1.5mm 0; }
.ctx-img { max-width: 80mm; max-height: 60mm; border: 1px solid #E6E6E6; }
.ctx-missing-img { color: #7E7F83; font-style: italic; }
`;
