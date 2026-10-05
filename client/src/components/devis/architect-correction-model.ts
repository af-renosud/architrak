import type { ArchitectCorrectionLine } from "@shared/architect-quotation";
export * from "@shared/architect-quotation";

export function createCorrectionLine(kind: ArchitectCorrectionLine["kind"], clientKey: string): ArchitectCorrectionLine {
  return { id: null, clientKey, kind, descriptionFr: "", descriptionEn: "", explanationFr: "", explanationEn: "",
    quantity: kind === "context" ? "0" : "1", unit: kind === "context" ? "" : "u",
    unitPriceHt: "0.00", totalHt: "0.00", vatRate: "", included: kind === "priced" };
}
export function reorderCorrectionLine(lines: ArchitectCorrectionLine[], from: number, to: number) {
  if (from < 0 || from >= lines.length || to < 0 || to >= lines.length) return lines;
  const next = [...lines], [line] = next.splice(from, 1);
  next.splice(to, 0, line);
  return next;
}
export function transferCorrectionPassage(lines: ArchitectCorrectionLine[], from: number, to: number, start: number, end: number, move: boolean) {
  if (from === to || !lines[from] || !lines[to] || end <= start || start < 0 || end > lines[from].descriptionFr.length) return lines;
  const source = lines[from].descriptionFr, passage = source.slice(start, end);
  return lines.map((line, index) => index === to ? { ...line, descriptionFr: [line.descriptionFr, passage].filter(Boolean).join("\n\n") }
    : index === from && move ? { ...line, descriptionFr: source.slice(0, start) + source.slice(end) } : line);
}
