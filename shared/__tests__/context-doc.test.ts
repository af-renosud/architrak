import { describe, it, expect } from "vitest";
import {
  contextDocSchema,
  isContextDocEmpty,
  collectContextAssetIds,
  isSafeContextHref,
  CONTEXT_DOC_MAX_JSON_BYTES,
  type ContextDoc,
} from "../context-doc";

const doc = (content: unknown[]): unknown => ({ type: "doc", content });
const para = (text: string, marks?: unknown[]): unknown => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
});

describe("contextDocSchema", () => {
  it("accepts a document with paragraphs, marks, lists, links and images", () => {
    const valid = doc([
      para("Plain intro"),
      para("Emphasised", [{ type: "bold" }, { type: "italic" }]),
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [para("first")] },
          {
            type: "listItem",
            content: [
              para("nested parent"),
              { type: "orderedList", content: [{ type: "listItem", content: [para("nested child")] }] },
            ],
          },
        ],
      },
      para("Watch the video", [{ type: "link", attrs: { href: "https://example.com/tour.mp4" } }]),
      para("Write us", [{ type: "link", attrs: { href: "mailto:office@example.com" } }]),
      { type: "image", attrs: { assetId: 12, alt: "site photo" } },
      { type: "paragraph", content: [{ type: "text", text: "line one" }, { type: "hardBreak" }, { type: "text", text: "line two" }] },
    ]);
    const result = contextDocSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects javascript:, data:, http: and malformed link hrefs", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://insecure.example.com",
      "file:///etc/passwd",
      "not a url",
      "//protocol-relative.example.com",
    ]) {
      const result = contextDocSchema.safeParse(doc([para("x", [{ type: "link", attrs: { href } }])]));
      expect(result.success, `href should be rejected: ${href}`).toBe(false);
    }
  });

  it("rejects unknown node types, unknown marks, and extra attributes", () => {
    expect(contextDocSchema.safeParse(doc([{ type: "iframe", attrs: { src: "https://x" } }])).success).toBe(false);
    expect(contextDocSchema.safeParse(doc([{ type: "heading", content: [{ type: "text", text: "h" }] }])).success).toBe(false);
    expect(contextDocSchema.safeParse(doc([para("x", [{ type: "underline" }])])).success).toBe(false);
    // link mark with extra attrs (e.g. TipTap's target/rel) must be rejected
    expect(
      contextDocSchema.safeParse(
        doc([para("x", [{ type: "link", attrs: { href: "https://a.com", target: "_blank" } }])]),
      ).success,
    ).toBe(false);
    // image node carrying a raw URL instead of an owned asset id
    expect(
      contextDocSchema.safeParse(doc([{ type: "image", attrs: { assetId: 1, src: "https://evil/x.png" } }])).success,
    ).toBe(false);
    // stray HTML-ish field on a text node
    expect(
      contextDocSchema.safeParse(doc([{ type: "paragraph", content: [{ type: "text", text: "x", html: "<b>" }] }])).success,
    ).toBe(false);
  });

  it("rejects a document exceeding the size cap", () => {
    const big = doc([para("y".repeat(CONTEXT_DOC_MAX_JSON_BYTES))]);
    const result = contextDocSchema.safeParse(big);
    expect(result.success).toBe(false);
  });

  it("rejects non-doc roots and non-positive asset ids", () => {
    expect(contextDocSchema.safeParse({ type: "paragraph", content: [] }).success).toBe(false);
    expect(contextDocSchema.safeParse(doc([{ type: "image", attrs: { assetId: 0 } }])).success).toBe(false);
    expect(contextDocSchema.safeParse(doc([{ type: "image", attrs: { assetId: -3 } }])).success).toBe(false);
  });
});

describe("isSafeContextHref", () => {
  it("allows https and mailto only", () => {
    expect(isSafeContextHref("https://example.com/video")).toBe(true);
    expect(isSafeContextHref("mailto:a@b.com")).toBe(true);
    expect(isSafeContextHref("http://example.com")).toBe(false);
    expect(isSafeContextHref("javascript:alert(1)")).toBe(false);
    expect(isSafeContextHref("ftp://example.com")).toBe(false);
  });
});

describe("isContextDocEmpty", () => {
  it("treats whitespace-only documents as empty", () => {
    expect(isContextDocEmpty({ type: "doc", content: [] } as ContextDoc)).toBe(true);
    expect(isContextDocEmpty(contextDocSchema.parse(doc([{ type: "paragraph" }])))).toBe(true);
    expect(isContextDocEmpty(contextDocSchema.parse(doc([para("   ")])))).toBe(true);
    expect(isContextDocEmpty(null)).toBe(true);
  });

  it("treats text, images, and list content as non-empty", () => {
    expect(isContextDocEmpty(contextDocSchema.parse(doc([para("hello")])))).toBe(false);
    expect(isContextDocEmpty(contextDocSchema.parse(doc([{ type: "image", attrs: { assetId: 4 } }])))).toBe(false);
    expect(
      isContextDocEmpty(
        contextDocSchema.parse(doc([{ type: "bulletList", content: [{ type: "listItem", content: [para("item")] }] }])),
      ),
    ).toBe(false);
  });
});

describe("collectContextAssetIds", () => {
  it("collects unique asset ids from top-level image nodes", () => {
    const parsed = contextDocSchema.parse(
      doc([
        { type: "image", attrs: { assetId: 3 } },
        para("between"),
        { type: "image", attrs: { assetId: 9 } },
        { type: "image", attrs: { assetId: 3 } },
      ]),
    );
    expect(collectContextAssetIds(parsed).sort((a, b) => a - b)).toEqual([3, 9]);
  });
});
