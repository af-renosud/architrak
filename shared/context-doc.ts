import { z } from "zod";

/**
 * Rich-text "context" document attached to a devis line item and rendered
 * into the translated devis PDF (Task: per-line context boxes).
 *
 * The persisted format is a deliberately SMALL subset of the TipTap /
 * ProseMirror JSON document model. The subset is enforced with strict Zod
 * schemas (unknown node types, marks, or attributes are rejected) so that:
 *   - the client editor and the server-side PDF serializer share one
 *     controlled model, and
 *   - no raw HTML is ever persisted or interpolated into the generated PDF.
 *
 * Allowed nodes:  doc, paragraph, hardBreak, text, bulletList, orderedList,
 *                 listItem, image (references an owned uploaded asset by id).
 * Allowed marks:  bold, italic, link (https:// or mailto: only).
 */

/** Upper bound on the serialized JSON size of one line's context document. */
export const CONTEXT_DOC_MAX_JSON_BYTES = 60_000;

/** Per-image upload cap (bytes) and per-line image count cap. */
export const CONTEXT_ASSET_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const CONTEXT_ASSETS_MAX_PER_LINE = 10;

/** MIME types accepted for context images (sniffed server-side, never trusted). */
export const CONTEXT_ASSET_ALLOWED_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ContextAssetMime = (typeof CONTEXT_ASSET_ALLOWED_MIMES)[number];

/** Reject anything that is not a plain https or mailto URL. */
export function isSafeContextHref(href: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "mailto:";
}

const linkMarkSchema = z
  .object({
    type: z.literal("link"),
    attrs: z
      .object({
        href: z
          .string()
          .max(2048)
          .refine(isSafeContextHref, { message: "Only https:// and mailto: links are allowed" }),
      })
      .strict(),
  })
  .strict();

const boldMarkSchema = z.object({ type: z.literal("bold") }).strict();
const italicMarkSchema = z.object({ type: z.literal("italic") }).strict();

export const contextMarkSchema = z.union([boldMarkSchema, italicMarkSchema, linkMarkSchema]);
export type ContextMark = z.infer<typeof contextMarkSchema>;

const textNodeSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1),
    marks: z.array(contextMarkSchema).max(4).optional(),
  })
  .strict();

const hardBreakNodeSchema = z.object({ type: z.literal("hardBreak") }).strict();

const inlineNodeSchema = z.union([textNodeSchema, hardBreakNodeSchema]);

/**
 * Block-level image node. It references an uploaded, ownership-verified
 * asset by numeric id — the document never carries storage keys or URLs,
 * so a crafted document cannot point the PDF renderer at arbitrary objects.
 */
const imageNodeSchema = z
  .object({
    type: z.literal("image"),
    attrs: z
      .object({
        assetId: z.number().int().positive(),
        alt: z.string().max(300).nullable().optional(),
      })
      .strict(),
  })
  .strict();

const paragraphNodeSchema = z
  .object({
    type: z.literal("paragraph"),
    content: z.array(inlineNodeSchema).max(500).optional(),
  })
  .strict();

type ListItemNode = {
  type: "listItem";
  content: (z.infer<typeof paragraphNodeSchema> | BulletListNode | OrderedListNode)[];
};
type BulletListNode = { type: "bulletList"; content: ListItemNode[] };
type OrderedListNode = { type: "orderedList"; content: ListItemNode[] };

const listItemNodeSchema: z.ZodType<ListItemNode> = z.lazy(() =>
  z
    .object({
      type: z.literal("listItem"),
      content: z
        .array(z.union([paragraphNodeSchema, bulletListNodeSchema, orderedListNodeSchema]))
        .min(1)
        .max(100),
    })
    .strict(),
);

const bulletListNodeSchema: z.ZodType<BulletListNode> = z.lazy(() =>
  z
    .object({
      type: z.literal("bulletList"),
      content: z.array(listItemNodeSchema).min(1).max(200),
    })
    .strict(),
);

const orderedListNodeSchema: z.ZodType<OrderedListNode> = z.lazy(() =>
  z
    .object({
      type: z.literal("orderedList"),
      content: z.array(listItemNodeSchema).min(1).max(200),
    })
    .strict(),
);

const blockNodeSchema = z.union([
  paragraphNodeSchema,
  bulletListNodeSchema,
  orderedListNodeSchema,
  imageNodeSchema,
]);

export const contextDocSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(blockNodeSchema).max(300),
  })
  .strict()
  .superRefine((doc, ctx) => {
    // TextEncoder is available in both Node and browsers (this module is shared).
    const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
    if (bytes > CONTEXT_DOC_MAX_JSON_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Context document too large (${bytes} bytes; max ${CONTEXT_DOC_MAX_JSON_BYTES})`,
      });
    }
  });

export type ContextDoc = z.infer<typeof contextDocSchema>;
export type ContextBlockNode = z.infer<typeof blockNodeSchema>;
export type ContextInlineNode = z.infer<typeof inlineNodeSchema>;
export type ContextParagraphNode = z.infer<typeof paragraphNodeSchema>;
export type ContextImageNode = z.infer<typeof imageNodeSchema>;
export type ContextListItemNode = ListItemNode;

/** True when the document carries no visible content (no text, image, or link). */
export function isContextDocEmpty(doc: ContextDoc | null | undefined): boolean {
  if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return true;
  const hasContent = (node: ContextBlockNode | ContextListItemNode): boolean => {
    if (node.type === "image") return true;
    if (node.type === "paragraph") {
      return (node.content ?? []).some((inline) => inline.type === "text" && inline.text.trim().length > 0);
    }
    // bulletList / orderedList / listItem
    return node.content.some((child) => hasContent(child as ContextBlockNode | ContextListItemNode));
  };
  return !doc.content.some(hasContent);
}

/** All asset ids referenced by image nodes in the document (deduplicated). */
export function collectContextAssetIds(doc: ContextDoc): number[] {
  const ids = new Set<number>();
  const walk = (node: ContextBlockNode | ContextListItemNode): void => {
    if (node.type === "image") {
      ids.add(node.attrs.assetId);
      return;
    }
    if (node.type === "paragraph") return;
    for (const child of node.content) walk(child as ContextBlockNode | ContextListItemNode);
  };
  for (const node of doc.content) walk(node);
  return Array.from(ids);
}
