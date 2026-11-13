import type { ReactNode } from "react";
import { CONTEXT_IMAGE_BOUNDS, isSafeContextHref } from "@shared/context-doc";
import type { ContextBlockNode, ContextDoc, ContextInlineNode, ContextListItemNode } from "@shared/context-doc";

function inline(node: ContextInlineNode, key: number): ReactNode {
  if (node.type === "hardBreak") return <br key={key} />;
  let result: ReactNode = node.text;
  for (const mark of node.marks ?? []) {
    if (mark.type === "bold") result = <strong>{result}</strong>;
    if (mark.type === "italic") result = <em>{result}</em>;
    if (mark.type === "link" && isSafeContextHref(mark.attrs.href)) {
      result = <a href={mark.attrs.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{result}</a>;
    }
  }
  return <span key={key}>{result}</span>;
}

function block(node: ContextBlockNode | ContextListItemNode, key: number, sourceId: number): ReactNode {
  if (node.type === "image") {
    const bounds = CONTEXT_IMAGE_BOUNDS[node.attrs.size ?? "medium"];
    return <figure key={key} className="my-2">
      <img src={`/api/devis/${sourceId}/context-assets/${node.attrs.assetId}`} alt={node.attrs.alt || "Original context image"}
        width={bounds.width} height={bounds.height} loading="lazy"
        style={{ width: bounds.width, maxHeight: bounds.height }}
        className="max-w-full rounded border object-contain object-left"
        onError={event => { event.currentTarget.alt = "Original context image could not load. Reopen this review to retry."; }} />
      <figcaption className="mt-1 text-xs text-muted-foreground">{node.attrs.size ?? "medium"} · {bounds.width} × {bounds.height}{node.attrs.alt ? ` · ${node.attrs.alt}` : ""}</figcaption>
    </figure>;
  }
  if (node.type === "paragraph") return <p key={key} className="min-h-4 whitespace-pre-wrap">{node.content?.map(inline)}</p>;
  const children = node.content.map((child, index) => block(child, index, sourceId));
  if (node.type === "bulletList") return <ul key={key} className="ml-5 list-disc">{children}</ul>;
  if (node.type === "orderedList") return <ol key={key} className="ml-5 list-decimal">{children}</ol>;
  return <li key={key}>{children}</li>;
}

/** React-only rendering: no stored HTML, arbitrary asset URLs or unsafe links. */
export function CarryForwardContextPreview({ document, sourceId }: { document: ContextDoc; sourceId: number }) {
  return <div className="space-y-1 break-words text-sm">{document.content.map((node, key) => block(node, key, sourceId))}</div>;
}
