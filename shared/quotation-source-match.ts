/**
 * Source identity, not working wording, determines whether previous authored
 * content can be reused. Never use fuzzy/AI similarity to authorise a copy.
 */
export interface SourceMatchItem {
  description: string;
  quantity?: string | number | null;
  unit?: string | null;
  unitPrice?: string | number | null;
  total?: string | number | null;
  /** Only supplied by the deterministic native-table reader, never by AI. */
  sectionPrefix?: string;
}

export function sourceMatchText(text: string): string {
  // Layout and typographic apostrophes are not changes to the specification.
  // Do not remove numbers, punctuation, headings or qualifications here.
  return text.normalize("NFC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLocaleLowerCase("fr");
}

export function sourceMatchKey(item: SourceMatchItem): string | null {
  const text = sourceMatchText(item.description);
  const numbers = [item.quantity, item.unitPrice, item.total].map(value =>
    value === null || value === undefined || String(value).trim() === "" ? null : Number(value));
  if (!text || numbers.some(n => n === null || !Number.isFinite(n))) return null;
  return JSON.stringify([text, sourceMatchText((item.unit ?? "").normalize("NFKC")), ...numbers]);
}

/** Repeated identical rows remain ambiguous; positional matching is unsafe. */
export function uniqueSourceMatches<S, T>(
  sources: S[], targets: T[], sourceItem: (row: S) => SourceMatchItem | null,
  targetItem: (row: T) => SourceMatchItem | null,
): Map<S, T> {
  const same = (a: SourceMatchItem | null, b: SourceMatchItem | null) => {
    if (!a || !b || !sourceMatchKey(a) || !sourceMatchKey(b)) return false;
    if (sourceMatchKey(a) === sourceMatchKey(b)) return true;
    const strip = (item: SourceMatchItem, prefix: string) => {
      const text = sourceMatchText(item.description), heading = sourceMatchText(prefix);
      return { ...item, description: text.startsWith(`${heading} `) ? text.slice(heading.length + 1) : text };
    };
    // Section titles may be repeated by one extraction and omitted by another.
    // Only a reader-proven heading may be ignored, never arbitrary text.
    return [a.sectionPrefix, b.sectionPrefix].some(prefix => prefix
      && sourceMatchKey(strip(a, prefix)) === sourceMatchKey(strip(b, prefix)));
  };
  const result = new Map<S, T>();
  const before = sources.map(row => ({ row, item: sourceItem(row) }));
  const after = targets.map(row => ({ row, item: targetItem(row) }));
  for (const source of before) {
    const matches = after.filter(target => same(source.item, target.item));
    if (matches.length === 1 && before.filter(other => same(other.item, matches[0].item)).length === 1)
      result.set(source.row, matches[0].row);
  }
  return result;
}
