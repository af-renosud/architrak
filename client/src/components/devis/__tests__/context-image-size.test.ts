// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { buildContextImageNode, normalizeEditorJson } from "../DevisLineContextEditor";
import { contextDocSchema, CONTEXT_IMAGE_SIZES } from "@shared/context-doc";
import { renderContextDocHtml } from "../../../../../server/communications/context-doc-renderer";

describe("quotation annotation image sizes", () => {
  it.each(CONTEXT_IMAGE_SIZES)("resizes only the selected image and persists %s through reload and PDF rendering", (size) => {
    const editor = new Editor({
      extensions: [StarterKit, buildContextImageNode(1)],
      content: { type: "doc", content: [
        { type: "image", attrs: { assetId: 1 } },
        { type: "image", attrs: { assetId: 2 } },
      ] },
    });
    editor.commands.setNodeSelection(0);
    editor.commands.updateAttributes("image", { size });
    const doc = contextDocSchema.parse(normalizeEditorJson(editor.getJSON()));
    expect(doc.content[0]).toMatchObject({ attrs: { assetId: 1, size } });
    expect(doc.content[1]).toEqual({ type: "image", attrs: { assetId: 2 } });
    editor.commands.setContent(JSON.parse(JSON.stringify(doc)));
    expect(editor.getHTML()).toContain(`data-image-size="${size}"`);
    const width = { small: 20, medium: 40, large: 80 }[size];
    expect(renderContextDocHtml(doc, new Map([[1, "data:image/png;base64,AAAA"]])))
      .toContain(`max-width:${width}mm`);
    editor.destroy();
  });

  it("keeps legacy documents valid and rejects arbitrary size/style values", () => {
    const doc = (attrs: object) => ({ type: "doc", content: [{ type: "image", attrs: { assetId: 1, ...attrs } }] });
    expect(contextDocSchema.safeParse(doc({})).success).toBe(true);
    expect(contextDocSchema.safeParse(doc({ size: "1000px" })).success).toBe(false);
    expect(contextDocSchema.safeParse(doc({ style: "width:1000px" })).success).toBe(false);
    const html = renderContextDocHtml(contextDocSchema.parse(doc({})), new Map([[1, "data:image/png;base64,AAAA"]]));
    expect(html).toContain("max-width:80mm");
  });
});
