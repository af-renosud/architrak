import type { ContextDoc } from "@shared/context-doc";

type PreviewNode = { type: string; text?: string; attrs?: { assetId?: number; alt?: string }; content?: PreviewNode[] };
export function ContextDocumentPreview({ document, devisId }: { document: ContextDoc | null; devisId: number }) {
  const render = (node: PreviewNode, index: number): React.ReactNode => {
    if (node.type === "image" && node.attrs?.assetId) return <a key={index} href={`/api/devis/${devisId}/context-assets/${node.attrs.assetId}`} target="_blank" rel="noreferrer">
      <img className="max-h-32 max-w-full" src={`/api/devis/${devisId}/context-assets/${node.attrs.assetId}`} alt={node.attrs.alt || "Quotation context image"} /></a>;
    if (node.type === "text") return <span key={index}>{node.text}</span>;
    return <div key={index}>{node.content?.map(render)}</div>;
  };
  return <div className="text-xs whitespace-pre-wrap max-h-52 overflow-auto">{document ? render(document as PreviewNode, 0) : "No previous context"}</div>;
}
