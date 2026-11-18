import type { ArchitectCorrectionDraft, ArchitectCorrectionLine } from "./architect-correction-model";

export interface DraftConflict { key: string; label: string; base: unknown; mine: unknown; latest: unknown }
export type MergeChoices = Record<string, "mine" | "latest">;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Field-level three-way merge. Stable row keys, not positions, define identity. */
export function mergeQuotationDraft(base: ArchitectCorrectionDraft, mine: ArchitectCorrectionDraft,
  latest: ArchitectCorrectionDraft, choices: MergeChoices = {}) {
  const conflicts: DraftConflict[] = [];
  const pick = (key: string, label: string, b: unknown, m: unknown, l: unknown): unknown => {
    if (same(m, b)) return l;
    if (same(l, b) || same(m, l)) return m;
    if (!choices[key]) conflicts.push({ key, label, base: b, mine: m, latest: l });
    return choices[key] === "mine" ? m : l;
  };
  const draft = { ...latest, lines: [] } as ArchitectCorrectionDraft;
  for (const key of Object.keys(latest) as Array<keyof ArchitectCorrectionDraft>) {
    if (key !== "lines") (draft as unknown as Record<string, unknown>)[key] = pick(key, key, base[key], mine[key], latest[key]);
  }
  // Match newly persisted local keys by ID too, without ever transferring an ID between rows.
  const identity = (row: ArchitectCorrectionLine) => row.id !== null ? `id:${row.id}` : row.clientKey;
  const b = new Map(base.lines.map(row => [identity(row), row]));
  const m = new Map(mine.lines.map(row => [identity(row), row]));
  const l = new Map(latest.lines.map(row => [identity(row), row]));
  const order = (rows: ArchitectCorrectionLine[]) => rows.map(identity).filter(key => b.has(key));
  const selectedOrder = pick("row-order", "Row order", order(base.lines), order(mine.lines), order(latest.lines)) as string[];
  const keys = Array.from(new Set([...selectedOrder, ...latest.lines.map(identity), ...mine.lines.map(identity)]));
  for (const key of keys) {
    const old = b.get(key), local = m.get(key), remote = l.get(key);
    if (!old || !local || !remote) {
      const row = pick(`row:${key}`, `Row ${key}`, old, local, remote) as ArchitectCorrectionLine | undefined;
      if (row) draft.lines.push(structuredClone(row));
      continue;
    }
    const row = { ...remote };
    for (const field of Object.keys(remote) as Array<keyof ArchitectCorrectionLine>) {
      if (field === "id" || field === "clientKey") continue;
      (row as unknown as Record<string, unknown>)[field] = pick(`${key}:${field}`,
        `${local.descriptionFr.slice(0, 45) || key} · ${field}`, old[field], local[field], remote[field]);
    }
    draft.lines.push(row);
  }
  return { draft, conflicts };
}
