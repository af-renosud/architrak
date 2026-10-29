import { describe, it, expect } from "vitest";
import { renderQuestionHtml, questionPlainText } from "../question-format";
describe("supplier question formatting", () => {
  it("keeps paragraphs, emphasis and lists", () => {
    const html = "<p><strong>Important</strong></p><ol><li><em>Confirm</em></li></ol>";
    expect(renderQuestionHtml(html)).toBe(html);
  });
  it("preserves legacy line breaks", () => {
    expect(renderQuestionHtml("First\n\nSecond")).toBe("First<br><br>Second");
  });
  it("escapes executable HTML and attributes", () => {
    const result = renderQuestionHtml('<img src=x onerror=alert(1)><script>alert(1)</script><p onclick="bad()">x</p>');
    expect(result).not.toContain("<img"); expect(result).not.toContain("<script");
    expect(result).not.toContain("<p onclick");
  });
  it("does not double encode editor entities on reopening", () => {
    expect(renderQuestionHtml("<p>A &amp; B</p>")).toBe("<p>A &amp; B</p>");
  });
  it("produces readable plain email summaries", () => {
    expect(questionPlainText("<p>First</p><ul><li>One &amp; two</li></ul>")).toBe("First\nOne & two");
  });
});
