import { describe, it, expect } from "vitest";
import { renderCostAnalysisHtml } from "../communications/cost-analysis-renderer";
import { parseCostAnalysisMarkdown } from "../../shared/cost-analysis-doc";

describe("renderCostAnalysisHtml", () => {
  it("renders headings, paragraphs, and tables", () => {
    const { document } = parseCostAnalysisMarkdown(`## Summary
Some **bold** text.

| A | B |
| --- | --- |
| one | two |`);
    const html = renderCostAnalysisHtml(document);
    expect(html).toContain('<h2 class="ca-h2">Summary</h2>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<table class="ca-table">');
    expect(html).toContain("<td>one</td>");
  });

  it("escapes all text content — no raw HTML injection", () => {
    const { document } = parseCostAnalysisMarkdown(
      `## <script>alert("x")</script>
Para with <img src=x onerror=alert(1)> & "quotes"

| <b>h</b> | B |
| --- | --- |
| <i>cell</i> | & |`,
    );
    const html = renderCostAnalysisHtml(document);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("emits no links or external references", () => {
    const { document } = parseCostAnalysisMarkdown("See https://example.com and [link](https://x.com)");
    const html = renderCostAnalysisHtml(document);
    expect(html).not.toContain("<a ");
    expect(html).toContain("https://example.com");
  });
});
