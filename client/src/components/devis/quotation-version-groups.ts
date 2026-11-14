/** Presentation only: never infer replacement from references, dates or amounts. */
export interface VersionedQuotation {
  id: number;
  status?: string | null;
  accountingState?: string | null;
}

export interface QuotationVersionGroup<T> {
  current: T;
  previous: T[];
}

export function isReplacedQuotation(row: VersionedQuotation): boolean {
  return row.status === "superseded" || row.accountingState === "superseded";
}

/**
 * Resolve complete, unambiguous chains before hiding anything. A broken path
 * stays flat, including upstream records; stale/error history is never trusted.
 * Void roots hidden by the toggle cannot swallow non-void historical evidence.
 */
export function groupQuotationVersions<T extends VersionedQuotation>(
  rows: readonly T[],
  history: readonly { oldDevisId: number; newDevisId: number }[] | undefined,
  { historyAvailable = true, showVoid = false } = {},
): QuotationVersionGroup<T>[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  const outgoing = new Map<number, Set<number>>();
  if (historyAvailable) {
    for (const edge of history ?? []) {
      const targets = outgoing.get(edge.oldDevisId) ?? new Set<number>();
      targets.add(edge.newDevisId);
      outgoing.set(edge.oldDevisId, targets);
    }
  }
  const roots = new Map<number, { id: number; depth: number }>();
  for (const row of rows) {
    if (!historyAvailable || !isReplacedQuotation(row)) continue;
    let cursor = row;
    let depth = 0;
    const visited = new Set<number>();
    while (isReplacedQuotation(cursor)) {
      if (visited.has(cursor.id)) break;
      visited.add(cursor.id);
      const targets = outgoing.get(cursor.id);
      if (targets?.size !== 1) break;
      const next = byId.get(Array.from(targets)[0]);
      if (!next) break;
      cursor = next;
      depth++;
    }
    if (isReplacedQuotation(cursor) || outgoing.has(cursor.id)) continue;
    if (!showVoid && cursor.status === "void") continue;
    roots.set(row.id, { id: cursor.id, depth });
  }
  const previousById = new Map<number, T[]>();
  for (const row of rows) {
    const root = roots.get(row.id);
    if (!root) continue;
    const previous = previousById.get(root.id) ?? [];
    previous.push(row);
    previousById.set(root.id, previous);
  }
  return rows
    .filter(row => !roots.has(row.id) && (showVoid || row.status !== "void"))
    .map(current => ({
      current,
      // Nearest predecessor first; ties retain the existing list order.
      previous: (previousById.get(current.id) ?? []).sort(
        (a, b) => roots.get(a.id)!.depth - roots.get(b.id)!.depth,
      ),
    }));
}

/** Filter whole families, not individual cards. Keep all evidence reachable. */
export function filterQuotationVersionGroups<T extends VersionedQuotation>(
  groups: readonly QuotationVersionGroup<T>[],
  matches: (row: T) => boolean,
  directLinkId: number | null = null,
): QuotationVersionGroup<T>[] {
  return groups.filter(group => [group.current, ...group.previous].some(
    row => row.id === directLinkId || matches(row),
  ));
}
