import { z } from "zod";

/**
 * Strict AST + tolerant markdown parser for the AI cost-analysis appendix
 * (Task #378). Deliberately SEPARATE from shared/context-doc.ts: this
 * document type is markdown-derived (headings, paragraphs, bold/italic,
 * pipe tables) and never carries links, images, or raw HTML.
 *
 * The parser is tolerant of the messy output real models produce —
 * fragmented table rows (a logical row split across several physical
 * lines), blank continuation lines inside tables, escaped pipes (\|) —
 * and reports problems as warnings instead of dropping content. Anything
 * it cannot place in a structured block is kept as a plain paragraph so
 * text is never silently lost.
 *
 * Shared so the client renders an exact preview with the same code path
 * the server uses at save time (the server always re-parses; the client
 * result is preview-only).
 */

// ---------------------------------------------------------------------------
// Limits (defense-in-depth; enforced by both parser and schema)
// ---------------------------------------------------------------------------

export const COST_ANALYSIS_MAX_RAW_BYTES = 200_000;
export const COST_ANALYSIS_MAX_BLOCKS = 300;
export const COST_ANALYSIS_MAX_TABLE_ROWS = 200;
export const COST_ANALYSIS_MAX_COLUMNS = 12;
export const COST_ANALYSIS_MAX_CELL_CHARS = 4_000;
export const COST_ANALYSIS_MAX_TEXT_CHARS = 20_000;

// ---------------------------------------------------------------------------
// AST schema
// ---------------------------------------------------------------------------

export const analysisInlineSchema = z.object({
  type: z.literal("text"),
  text: z.string().max(COST_ANALYSIS_MAX_TEXT_CHARS),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});
export type AnalysisInline = z.infer<typeof analysisInlineSchema>;

const inlineArraySchema = z.array(analysisInlineSchema).max(200);

export const analysisHeadingSchema = z.object({
  type: z.literal("heading"),
  level: z.union([z.literal(2), z.literal(3)]),
  content: inlineArraySchema,
});

export const analysisParagraphSchema = z.object({
  type: z.literal("paragraph"),
  content: inlineArraySchema,
});

const cellSchema = inlineArraySchema;
const rowSchema = z.array(cellSchema).max(COST_ANALYSIS_MAX_COLUMNS);

export const analysisTableSchema = z.object({
  type: z.literal("table"),
  header: rowSchema,
  rows: z.array(rowSchema).max(COST_ANALYSIS_MAX_TABLE_ROWS),
});

export const analysisBlockSchema = z.discriminatedUnion("type", [
  analysisHeadingSchema,
  analysisParagraphSchema,
  analysisTableSchema,
]);
export type AnalysisBlock = z.infer<typeof analysisBlockSchema>;

export const costAnalysisDocumentSchema = z.object({
  version: z.literal(1),
  blocks: z.array(analysisBlockSchema).max(COST_ANALYSIS_MAX_BLOCKS),
});
export type CostAnalysisDocument = z.infer<typeof costAnalysisDocumentSchema>;

export interface CostAnalysisParseResult {
  document: CostAnalysisDocument;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Inline (bold/italic) tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenizes **bold**, *italic* and plain text. Unmatched markers are kept
 * as literal text. No nesting (matches the strict Gem output format).
 */
export function parseInline(text: string): AnalysisInline[] {
  const out: AnalysisInline[] = [];
  let rest = text;
  const push = (t: string, marks?: { bold?: boolean; italic?: boolean }) => {
    if (!t) return;
    out.push({ type: "text", text: t, ...(marks?.bold ? { bold: true } : {}), ...(marks?.italic ? { italic: true } : {}) });
  };
  while (rest.length > 0) {
    const m = rest.match(/\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/);
    if (!m || m.index === undefined) {
      push(rest);
      break;
    }
    push(rest.slice(0, m.index));
    if (m[1] !== undefined) push(m[1], { bold: true });
    else push(m[2] ?? "", { italic: true });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

const PIPE_PLACEHOLDER = "\u0000";

function isPipeLine(line: string): boolean {
  return line.replace(/\\\|/g, PIPE_PLACEHOLDER).includes("|");
}

function isDelimiterLine(line: string): boolean {
  const t = line.trim();
  return /^\|?[\s:|-]+\|?$/.test(t) && t.includes("-") && t.includes("|") === t.includes("|");
}

/** Splits a physical line into cell fragments on unescaped pipes. */
function splitCells(line: string): string[] {
  const protectedLine = line.replace(/\\\|/g, PIPE_PLACEHOLDER);
  const parts = protectedLine.split("|").map((p) => p.replace(new RegExp(PIPE_PLACEHOLDER, "g"), "|").trim());
  // Drop the empty edge tokens produced by leading/trailing pipes.
  while (parts.length > 0 && parts[0] === "") parts.shift();
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function countDelimiterColumns(line: string): number {
  return splitCells(line).length;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseCostAnalysisMarkdown(raw: string): CostAnalysisParseResult {
  const warnings: string[] = [];
  const blocks: AnalysisBlock[] = [];

  if (typeof raw !== "string") {
    throw new Error("Cost analysis text must be a string");
  }
  const byteLength = new TextEncoder().encode(raw).length;
  if (byteLength > COST_ANALYSIS_MAX_RAW_BYTES) {
    throw new Error(`Cost analysis text too large (${byteLength} bytes, max ${COST_ANALYSIS_MAX_RAW_BYTES})`);
  }

  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    const text = paragraphBuffer.join(" ").trim();
    paragraphBuffer = [];
    if (!text) return;
    blocks.push({ type: "paragraph", content: parseInline(text) });
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line: paragraph boundary.
    if (trimmed === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    // Horizontal rules / stray fence markers: ignore.
    if (/^(-{3,}|_{3,}|\*{3,}|```.*)$/.test(trimmed)) {
      flushParagraph();
      i += 1;
      continue;
    }

    // Headings (## / ###; # is demoted to ##, deeper demoted to ###).
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length <= 2 ? 2 : 3;
      blocks.push({ type: "heading", level, content: parseInline(headingMatch[2].trim()) });
      i += 1;
      continue;
    }

    // Table start: a pipe line whose NEXT non-blank line is a delimiter row.
    if (isPipeLine(trimmed) && trimmed.startsWith("|")) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j += 1;
      const delim = j < lines.length ? lines[j].trim() : "";
      if (delim && isDelimiterLine(delim) && isPipeLine(delim)) {
        flushParagraph();
        const headerCells = splitCells(trimmed);
        const columnCount = Math.max(headerCells.length, countDelimiterColumns(delim));
        if (columnCount > COST_ANALYSIS_MAX_COLUMNS) {
          throw new Error(`Table has ${columnCount} columns (max ${COST_ANALYSIS_MAX_COLUMNS})`);
        }
        if (headerCells.length !== columnCount) {
          warnings.push(`Table header has ${headerCells.length} cells but the delimiter row declares ${columnCount} columns.`);
          while (headerCells.length < columnCount) headerCells.push("");
        }

        const rows: string[][] = [];
        let cellBuffer: string[] = [];
        let sawFragmentedRow = false;
        let k = j + 1;
        while (k < lines.length) {
          const rowLine = lines[k].trim();
          if (rowLine === "") {
            // Blank continuation line inside a fragmented table: skip, but
            // only while we're mid-row; a blank line between complete rows
            // is also tolerated (models emit both).
            k += 1;
            continue;
          }
          if (!isPipeLine(rowLine)) break;
          if (isDelimiterLine(rowLine)) {
            k += 1;
            continue;
          }
          const cells = splitCells(rowLine);
          if (cellBuffer.length === 0 && cells.length === columnCount) {
            rows.push(cells);
          } else {
            sawFragmentedRow = true;
            cellBuffer.push(...cells.filter((c, idx) => c !== "" || (idx > 0 && idx < cells.length - 1)));
            while (cellBuffer.length >= columnCount) {
              rows.push(cellBuffer.slice(0, columnCount));
              cellBuffer = cellBuffer.slice(columnCount);
            }
          }
          if (rows.length > COST_ANALYSIS_MAX_TABLE_ROWS) {
            throw new Error(`Table has more than ${COST_ANALYSIS_MAX_TABLE_ROWS} rows`);
          }
          k += 1;
        }
        if (cellBuffer.length > 0) {
          warnings.push(
            `A table row ended with ${cellBuffer.length} cell(s) instead of ${columnCount}; the partial row was kept — please review it.`,
          );
          while (cellBuffer.length < columnCount) cellBuffer.push("");
          rows.push(cellBuffer);
        }
        if (sawFragmentedRow) {
          warnings.push("Some table rows were split across multiple lines and were reassembled — please verify the table content.");
        }

        for (const cells of rows) {
          for (const c of cells) {
            if (c.length > COST_ANALYSIS_MAX_CELL_CHARS) {
              throw new Error(`Table cell too long (${c.length} chars, max ${COST_ANALYSIS_MAX_CELL_CHARS})`);
            }
          }
        }

        blocks.push({
          type: "table",
          header: headerCells.map(parseInline),
          rows: rows.map((cells) => cells.map(parseInline)),
        });
        i = k;
        continue;
      }
    }

    // Loose pipe line with no delimiter row: keep as text with a warning.
    if (isPipeLine(trimmed) && trimmed.startsWith("|")) {
      warnings.push("A table-like line had no delimiter row and was kept as plain text — please review it.");
    }

    // List items render as plain paragraphs (strict format forbids lists,
    // but never drop content).
    paragraphBuffer.push(trimmed.replace(/^[-*]\s+/, "— "));
    i += 1;
  }
  flushParagraph();

  if (blocks.length > COST_ANALYSIS_MAX_BLOCKS) {
    throw new Error(`Document has ${blocks.length} blocks (max ${COST_ANALYSIS_MAX_BLOCKS})`);
  }

  const document: CostAnalysisDocument = { version: 1, blocks };
  // Final schema validation — the AST we hand out is always schema-valid.
  costAnalysisDocumentSchema.parse(document);
  return { document, warnings };
}

/** Plain-text projection of inline content (for warnings/summaries). */
export function inlineToPlainText(content: AnalysisInline[]): string {
  return content.map((n) => n.text).join("");
}
