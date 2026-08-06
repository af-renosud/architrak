import { describe, it, expect } from "vitest";
import { renderContextDocHtml } from "../context-doc-renderer";
import { contextDocSchema } from "@shared/context-doc";

const parse = (content: unknown[]) => contextDocSchema.parse({ type: "doc", content });

describe("renderContextDocHtml", () => {
  it("escapes text content — HTML in text can never become markup", () => {
    const doc = parse([
      { type: "paragraph", content: [{ type: "text", text: `<script>alert("x")</script> & 'quotes'` }] },
    ]);
    const html = renderContextDocHtml(doc, new Map());
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("renders bold/italic marks and hard breaks", () => {
    const doc = parse([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "strong", marks: [{ type: "bold" }] },
          { type: "hardBreak" },
          { type: "text", text: "slanted", marks: [{ type: "italic" }] },
        ],
      },
    ]);
    const html = renderContextDocHtml(doc, new Map());
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<br />");
    expect(html).toContain("<em>slanted</em>");
  });

  it("renders clickable links with the URL printed visibly for paper copies", () => {
    const doc = parse([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "installation video", marks: [{ type: "link", attrs: { href: "https://example.com/v.mp4" } }] },
        ],
      },
    ]);
    const html = renderContextDocHtml(doc, new Map());
    expect(html).toContain(`<a href="https://example.com/v.mp4" class="ctx-link">installation video</a>`);
    expect(html).toContain(`<span class="ctx-url">(https://example.com/v.mp4)</span>`);
  });

  it("does not duplicate the URL when the link text IS the URL", () => {
    const doc = parse([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "https://example.com/v.mp4", marks: [{ type: "link", attrs: { href: "https://example.com/v.mp4" } }] },
        ],
      },
    ]);
    const html = renderContextDocHtml(doc, new Map());
    expect(html.match(/example\.com\/v\.mp4/g)?.length).toBe(2); // href + text, no extra span
    expect(html).not.toContain("ctx-url");
  });

  it("renders nested lists", () => {
    const doc = parse([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "outer" }] },
              {
                type: "orderedList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const html = renderContextDocHtml(doc, new Map());
    expect(html).toContain("<ul><li><p>outer</p><ol><li><p>inner</p></li></ol></li></ul>");
  });

  it("inlines resolved image assets as data URIs and shows a placeholder otherwise", () => {
    const doc = parse([
      { type: "image", attrs: { assetId: 5, alt: `photo "site"` } },
      { type: "image", attrs: { assetId: 6 } },
    ]);
    const uris = new Map<number, string>([[5, "data:image/png;base64,AAAA"]]);
    const html = renderContextDocHtml(doc, uris);
    expect(html).toContain(`src="data:image/png;base64,AAAA"`);
    expect(html).toContain(`alt="photo &quot;site&quot;"`);
    expect(html).toContain("[image unavailable]");
  });

  it("refuses non-data URIs supplied for images (defense in depth)", () => {
    const doc = parse([{ type: "image", attrs: { assetId: 7 } }]);
    const uris = new Map<number, string>([[7, "https://attacker.example/x.png"]]);
    const html = renderContextDocHtml(doc, uris);
    expect(html).not.toContain("attacker.example");
    expect(html).toContain("[image unavailable]");
  });
});
