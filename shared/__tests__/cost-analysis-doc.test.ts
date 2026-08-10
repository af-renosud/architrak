import { describe, it, expect } from "vitest";
import {
  parseCostAnalysisMarkdown,
  parseInline,
  inlineToPlainText,
  costAnalysisDocumentSchema,
  COST_ANALYSIS_MAX_RAW_BYTES,
} from "../cost-analysis-doc";

describe("parseInline", () => {
  it("tokenizes bold and italic", () => {
    const out = parseInline("plain **bold** and *ital* end");
    expect(out).toEqual([
      { type: "text", text: "plain " },
      { type: "text", text: "bold", bold: true },
      { type: "text", text: " and " },
      { type: "text", text: "ital", italic: true },
      { type: "text", text: " end" },
    ]);
  });

  it("keeps unmatched markers literal", () => {
    const out = parseInline("a ** b");
    expect(inlineToPlainText(out)).toBe("a ** b");
  });
});

describe("parseCostAnalysisMarkdown", () => {
  it("parses the standard well-formed template", () => {
    const raw = `## Summary
Intro paragraph with **bold** emphasis.

## Cost Center Summary
| Cost Center | Included Sub-Works | Necessity | Est. Cost (TTC) | Savings Opportunity |
| --- | --- | --- | --- | --- |
| Exterior Terrace | Site setup; draining; tiling | Mixed | €20,997.87 | Medium |
| Structural Works | Slab; reinforcement | Mandatory | €35,000.00 | Low |

## Value Engineering
**Opportunity:** Swap membrane. **Estimated Saving:** €1,800.`;
    const { document, warnings } = parseCostAnalysisMarkdown(raw);
    expect(warnings).toEqual([]);
    expect(document.blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "table",
      "heading",
      "paragraph",
    ]);
    const table = document.blocks[3] as Extract<(typeof document.blocks)[number], { type: "table" }>;
    expect(table.header).toHaveLength(5);
    expect(table.rows).toHaveLength(2);
    expect(inlineToPlainText(table.rows[0][3])).toBe("€20,997.87");
  });

  it("reassembles fragmented table rows and warns", () => {
    const raw = `## Cost Center Summary
| Cost Center | Sub-Works | Necessity | Cost | Savings |
| --- | --- | --- | --- | --- |
| **1. Terrace** | Site setup; draining
| Mandatory | €20,997.87
| Low |
| Kitchen | Cabinets | Optional | €9,000.00 | High |`;
    const { document, warnings } = parseCostAnalysisMarkdown(raw);
    const table = document.blocks[1] as Extract<(typeof document.blocks)[number], { type: "table" }>;
    expect(table.rows).toHaveLength(2);
    expect(inlineToPlainText(table.rows[0][0])).toBe("1. Terrace");
    expect(table.rows[0][0][0].bold).toBe(true);
    expect(inlineToPlainText(table.rows[0][4])).toBe("Low");
    expect(inlineToPlainText(table.rows[1][0])).toBe("Kitchen");
    expect(warnings.some((w) => w.includes("reassembled"))).toBe(true);
  });

  it("tolerates blank lines inside fragmented tables", () => {
    const raw = `| A | B | C |
| --- | --- | --- |
| one | two

| three |
| x | y | z |`;
    const { document } = parseCostAnalysisMarkdown(raw);
    const table = document.blocks[0] as Extract<(typeof document.blocks)[number], { type: "table" }>;
    expect(table.rows).toEqual([
      [
        [{ type: "text", text: "one" }],
        [{ type: "text", text: "two" }],
        [{ type: "text", text: "three" }],
      ],
      [
        [{ type: "text", text: "x" }],
        [{ type: "text", text: "y" }],
        [{ type: "text", text: "z" }],
      ],
    ]);
  });

  it("handles escaped pipes inside cells", () => {
    const raw = `| A | B |
| --- | --- |
| left \\| still left | right |`;
    const { document, warnings } = parseCostAnalysisMarkdown(raw);
    const table = document.blocks[0] as Extract<(typeof document.blocks)[number], { type: "table" }>;
    expect(warnings).toEqual([]);
    expect(inlineToPlainText(table.rows[0][0])).toBe("left | still left");
  });

  it("keeps a trailing partial row with a warning, never drops it", () => {
    const raw = `| A | B | C |
| --- | --- | --- |
| one | two |`;
    const { document, warnings } = parseCostAnalysisMarkdown(raw);
    const table = document.blocks[0] as Extract<(typeof document.blocks)[number], { type: "table" }>;
    expect(table.rows).toHaveLength(1);
    expect(inlineToPlainText(table.rows[0][0])).toBe("one");
    expect(table.rows[0][2]).toEqual([]);
    expect(warnings.some((w) => w.includes("partial row"))).toBe(true);
  });

  it("keeps table-like lines without a delimiter as text with a warning", () => {
    const raw = `| looks like a table but is not |`;
    const { document, warnings } = parseCostAnalysisMarkdown(raw);
    expect(document.blocks[0].type).toBe("paragraph");
    expect(warnings.some((w) => w.includes("no delimiter"))).toBe(true);
  });

  it("ignores horizontal rules and demotes heading levels", () => {
    const raw = `# Top\n---\n#### Deep`;
    const { document } = parseCostAnalysisMarkdown(raw);
    expect(document.blocks).toHaveLength(2);
    expect(document.blocks[0]).toMatchObject({ type: "heading", level: 2 });
    expect(document.blocks[1]).toMatchObject({ type: "heading", level: 3 });
  });

  it("never interprets HTML — text is preserved verbatim for escaping downstream", () => {
    const raw = `<script>alert(1)</script> **<b>x</b>**`;
    const { document } = parseCostAnalysisMarkdown(raw);
    const para = document.blocks[0] as Extract<(typeof document.blocks)[number], { type: "paragraph" }>;
    expect(inlineToPlainText(para.content)).toBe("<script>alert(1)</script> <b>x</b>");
  });

  it("rejects oversized input explicitly", () => {
    const raw = "x".repeat(COST_ANALYSIS_MAX_RAW_BYTES + 1);
    expect(() => parseCostAnalysisMarkdown(raw)).toThrow(/too large/);
  });

  it("produces schema-valid documents", () => {
    const { document } = parseCostAnalysisMarkdown("## H\ntext");
    expect(costAnalysisDocumentSchema.safeParse(document).success).toBe(true);
  });
});
