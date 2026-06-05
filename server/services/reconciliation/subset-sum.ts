// Task #231 — deterministic subset-sum screening.
//
// Pure, dependency-free, integer-cents arithmetic. Given a target total
// (a candidate "consolidator" devis) and a pool of smaller devis, find
// every subset whose totals add up to the target within a small rounding
// tolerance. An exact match is the arithmetic fingerprint of a
// consolidated devis having absorbed those earlier ones (silent
// double-counting). This layer makes NO semantic judgement — it only
// surfaces arithmetically plausible groupings for the reasoning step.
//
// Bounded by construction: the candidate pool and subset size are capped
// by the caller so the backtracking search can never blow up
// combinatorially on a pathological project.

export interface SubsetCandidate {
  devisId: number;
  cents: number;
}

export interface SubsetMatch {
  memberDevisIds: number[];
  sumCents: number;
  deltaCents: number;
}

export interface SubsetSumOptions {
  // Max members in a matching subset. Default 5 — real-world
  // consolidations rarely fold more than a handful of devis.
  maxSubsetSize?: number;
  // Allowed |sum - target| in cents. Default 0 (exact). A tiny tolerance
  // (e.g. number of members) absorbs per-line 2-decimal rounding drift.
  toleranceCents?: number;
  // Hard cap on candidates considered, applied after sorting by size
  // descending. Default 16 → at most C(16, ≤5) subsets explored.
  maxCandidates?: number;
}

const DEFAULTS = {
  maxSubsetSize: 5,
  toleranceCents: 0,
  maxCandidates: 16,
} as const;

/**
 * Find subsets of `candidates` (size 2..maxSubsetSize) whose cents sum to
 * `targetCents` within tolerance. Subsets of size 1 are excluded — a
 * single devis equalling the target is a `duplicate`/`supersedes`
 * relationship handled by the semantic layer, not an aggregation.
 *
 * Results are de-duplicated by membership and returned smallest-subset
 * first (the most specific explanation), then by ascending delta.
 */
export function findSubsetSums(
  targetCents: number,
  candidates: SubsetCandidate[],
  options: SubsetSumOptions = {},
): SubsetMatch[] {
  const maxSubsetSize = options.maxSubsetSize ?? DEFAULTS.maxSubsetSize;
  const toleranceCents = options.toleranceCents ?? DEFAULTS.toleranceCents;
  const maxCandidates = options.maxCandidates ?? DEFAULTS.maxCandidates;

  if (!Number.isFinite(targetCents) || targetCents <= 0) return [];

  // Only smaller-than-target, positive candidates can be members. Sort by
  // cents descending so we can prune (remaining items too small to reach
  // target) and so the cap keeps the most significant devis.
  const pool = candidates
    .filter((c) => Number.isFinite(c.cents) && c.cents > 0 && c.cents <= targetCents + toleranceCents)
    .sort((a, b) => b.cents - a.cents)
    .slice(0, maxCandidates);

  // Suffix sums for pruning: maxReachable[i] = sum of pool[i..].
  const suffix = new Array<number>(pool.length + 1).fill(0);
  for (let i = pool.length - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1] + pool[i].cents;
  }

  const matches: SubsetMatch[] = [];
  const chosen: SubsetCandidate[] = [];

  const recurse = (start: number, runningCents: number): void => {
    if (chosen.length >= 2) {
      const delta = Math.abs(runningCents - targetCents);
      if (delta <= toleranceCents) {
        matches.push({
          memberDevisIds: chosen.map((c) => c.devisId).sort((a, b) => a - b),
          sumCents: runningCents,
          deltaCents: runningCents - targetCents,
        });
        // Keep searching: other subsets may also match.
      }
    }
    if (chosen.length >= maxSubsetSize) return;
    for (let i = start; i < pool.length; i++) {
      const next = runningCents + pool[i].cents;
      // Overshoot beyond tolerance — since pool is sorted desc, later
      // items are smaller, so this branch can still be useful; only prune
      // when even the current single add already exceeds tolerance AND we
      // already have ≥1 member (adding more only grows the sum).
      if (next - targetCents > toleranceCents) continue;
      // Prune: can the remaining suffix ever reach the target?
      if (next + (suffix[i + 1]) < targetCents - toleranceCents) {
        // Adding pool[i] plus everything after still can't reach target.
        // Because pool is desc-sorted, no later start does better.
        break;
      }
      chosen.push(pool[i]);
      recurse(i + 1, next);
      chosen.pop();
    }
  };

  recurse(0, 0);

  // De-duplicate identical memberships (defensive — recursion shouldn't
  // produce dupes, but guard anyway) and order by specificity.
  const seen = new Set<string>();
  const unique = matches.filter((m) => {
    const key = m.memberDevisIds.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) =>
    a.memberDevisIds.length - b.memberDevisIds.length
    || Math.abs(a.deltaCents) - Math.abs(b.deltaCents),
  );
  return unique;
}
