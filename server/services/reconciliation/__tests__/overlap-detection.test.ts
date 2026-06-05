import { describe, it, expect } from "vitest";
import { findSubsetSums } from "../subset-sum";
import { computeCaseKey } from "../overlap-detection.service";

describe("findSubsetSums", () => {
  it("finds a 2-member subset summing exactly to the target", () => {
    const matches = findSubsetSums(30000, [
      { devisId: 1, cents: 10000 },
      { devisId: 2, cents: 20000 },
      { devisId: 3, cents: 50000 },
    ]);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].memberDevisIds).toEqual([1, 2]);
    expect(matches[0].sumCents).toBe(30000);
    expect(matches[0].deltaCents).toBe(0);
  });

  it("excludes single-member subsets (a lone equal devis is not an aggregation)", () => {
    const matches = findSubsetSums(50000, [
      { devisId: 1, cents: 50000 },
      { devisId: 2, cents: 10000 },
    ]);
    expect(matches.every((m) => m.memberDevisIds.length >= 2)).toBe(true);
    expect(matches.some((m) => m.memberDevisIds.includes(1) && m.memberDevisIds.length === 1)).toBe(false);
  });

  it("honours tolerance to absorb per-line rounding drift", () => {
    // 10000 + 20003 = 30003, target 30000, delta 3 within tolerance 3.
    const within = findSubsetSums(30000, [
      { devisId: 1, cents: 10000 },
      { devisId: 2, cents: 20003 },
    ], { toleranceCents: 3 });
    expect(within.length).toBe(1);
    expect(within[0].memberDevisIds).toEqual([1, 2]);
    // Exact (tolerance 0) finds nothing.
    const exact = findSubsetSums(30000, [
      { devisId: 1, cents: 10000 },
      { devisId: 2, cents: 20003 },
    ]);
    expect(exact.length).toBe(0);
  });

  it("returns nothing for non-positive or non-finite targets", () => {
    expect(findSubsetSums(0, [{ devisId: 1, cents: 100 }])).toEqual([]);
    expect(findSubsetSums(-100, [{ devisId: 1, cents: 100 }])).toEqual([]);
    expect(findSubsetSums(Number.NaN, [{ devisId: 1, cents: 100 }])).toEqual([]);
  });

  it("ignores candidates larger than target + tolerance", () => {
    const matches = findSubsetSums(30000, [
      { devisId: 1, cents: 10000 },
      { devisId: 2, cents: 20000 },
      { devisId: 3, cents: 40000 },
    ]);
    expect(matches.some((m) => m.memberDevisIds.includes(3))).toBe(false);
  });
});

describe("computeCaseKey", () => {
  it("is deterministic for identical inputs", () => {
    const a = computeCaseKey({ projectId: 7, relationshipType: "consolidates", primaryDevisId: 10, memberDevisIds: [1, 2, 3] });
    const b = computeCaseKey({ projectId: 7, relationshipType: "consolidates", primaryDevisId: 10, memberDevisIds: [1, 2, 3] });
    expect(a).toBe(b);
  });

  it("is order-independent in memberDevisIds (idempotent regardless of input order)", () => {
    const a = computeCaseKey({ projectId: 7, relationshipType: "consolidates", primaryDevisId: 10, memberDevisIds: [1, 2, 3] });
    const b = computeCaseKey({ projectId: 7, relationshipType: "consolidates", primaryDevisId: 10, memberDevisIds: [3, 1, 2] });
    expect(a).toBe(b);
  });

  it("differs when any salient component changes", () => {
    const base = computeCaseKey({ projectId: 7, relationshipType: "consolidates", primaryDevisId: 10, memberDevisIds: [1, 2] });
    expect(base).not.toBe(computeCaseKey({ projectId: 8, relationshipType: "consolidates", primaryDevisId: 10, memberDevisIds: [1, 2] }));
    expect(base).not.toBe(computeCaseKey({ projectId: 7, relationshipType: "supersedes", primaryDevisId: 10, memberDevisIds: [1, 2] }));
    expect(base).not.toBe(computeCaseKey({ projectId: 7, relationshipType: "consolidates", primaryDevisId: 11, memberDevisIds: [1, 2] }));
    expect(base).not.toBe(computeCaseKey({ projectId: 7, relationshipType: "consolidates", primaryDevisId: 10, memberDevisIds: [1, 2, 3] }));
  });
});
