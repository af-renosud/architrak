import { describe, expect, it } from "vitest";
import { filterQuotationVersionGroups, groupQuotationVersions } from "../quotation-version-groups";

const old = { id: 17, status: "signed", accountingState: "superseded", ref: "OLD-17", lot: "FD" };
const middle = { id: 24, status: "superseded", accountingState: "active", ref: "MID-24", lot: "EL" };
const current = { id: 38, status: "draft", accountingState: "active", ref: "NEW-38", lot: "PL" };
const rows = [old, middle, current];
const edges = [{ oldDevisId: 17, newDevisId: 24 }, { oldDevisId: 24, newDevisId: 38 }];
const ids = (groups: ReturnType<typeof groupQuotationVersions>) =>
  groups.flatMap(group => [group.current, ...group.previous]).map(row => row.id).sort((a, b) => a - b);

describe("explicit quotation version families", () => {
  it("groups full chains under the latest descendant with nearest predecessor first", () => {
    const result = groupQuotationVersions(Object.freeze(rows), Object.freeze(edges));
    expect(result).toEqual([{ current, previous: [middle, old] }]);
    expect(result[0].current).toBe(current);
    expect(rows).toEqual([old, middle, current]);
  });

  it("does not infer links from shared references or superseded status alone", () => {
    expect(groupQuotationVersions(rows, [])).toEqual(rows.map(current => ({ current, previous: [] })));
    expect(groupQuotationVersions([old, { ...current, ref: old.ref }], [])).toHaveLength(2);
    const notSuperseded = { ...old, status: "signed", accountingState: "active" };
    expect(groupQuotationVersions([notSuperseded, current], [{ oldDevisId: 17, newDevisId: 38 }])).toHaveLength(2);
  });

  it.each([
    ["missing outgoing edge", edges.slice(0, 1)],
    ["missing target", [edges[0], { oldDevisId: 24, newDevisId: 99 }]],
    ["cycle", [edges[0], { oldDevisId: 24, newDevisId: 17 }]],
    ["self cycle", [{ oldDevisId: 17, newDevisId: 17 }]],
    ["ambiguous successor", [...edges, { oldDevisId: 24, newDevisId: 55 }]],
    ["inconsistent active terminal with outgoing edge", [...edges, { oldDevisId: 38, newDevisId: 55 }]],
  ])("keeps all evidence standalone for %s", (_, history) => {
    const groups = groupQuotationVersions(rows, history);
    expect(ids(groups)).toEqual([17, 24, 38]);
    expect(groups.every(group => group.previous.length === 0)).toBe(true);
  });

  it("preserves upstream evidence when a chain enters a cycle", () => {
    const groups = groupQuotationVersions(rows, [...edges, { oldDevisId: 38, newDevisId: 24 }]);
    expect(ids(groups)).toEqual([17, 24, 38]);
    expect(groups).toHaveLength(3);
  });

  it("fails open for loading/missing/error history, including stale cached data", () => {
    expect(groupQuotationVersions(rows, undefined)).toHaveLength(3);
    expect(groupQuotationVersions(rows, edges, { historyAvailable: false })).toHaveLength(3);
  });

  it("tolerates duplicate copies of the same explicit edge", () => {
    expect(groupQuotationVersions(rows, [...edges, edges[0]])).toHaveLength(1);
  });

  it("retains void historical evidence, while honoring the standalone void toggle", () => {
    const voidOld = { ...old, status: "void" };
    const voidOther = { ...current, id: 55, status: "void" };
    const groups = groupQuotationVersions([voidOld, middle, current, voidOther], edges);
    expect(groups).toEqual([{ current, previous: [middle, voidOld] }]);
    expect(ids(groupQuotationVersions([voidOld, middle, current, voidOther], edges, { showVoid: true }))).toEqual([17, 24, 38, 55]);
  });

  it("never hides non-void historical evidence behind a hidden void successor", () => {
    const voidCurrent = { ...current, status: "void" };
    expect(groupQuotationVersions([old, middle, voidCurrent], edges)).toEqual([
      { current: old, previous: [] }, { current: middle, previous: [] },
    ]);
    expect(groupQuotationVersions([old, middle, voidCurrent], edges, { showVoid: true }))
      .toEqual([{ current: voidCurrent, previous: [middle, old] }]);
  });

  it("has no-loss coverage for mixed valid and broken families", () => {
    const orphan = { ...old, id: 55 };
    const groups = groupQuotationVersions([...rows, orphan], edges);
    expect(ids(groups)).toEqual([17, 24, 38, 55]);
    expect(new Set(ids(groups)).size).toBe(4);
    expect(groups).toHaveLength(2);
  });
});

describe("family-level filters and direct links", () => {
  const groups = groupQuotationVersions(rows, edges);
  it("an old-reference match returns the current card and all original versions", () => {
    expect(filterQuotationVersionGroups(groups, row => row.ref === "OLD-17")).toEqual(groups);
  });
  it("a historical lot match never orphans the old row", () => {
    expect(filterQuotationVersionGroups(groups, row => row.lot === "FD")).toEqual(groups);
    expect(filterQuotationVersionGroups(groups, row => row.lot === "FD" && row.ref === "NEW-38")).toEqual([]);
  });
  it("keeps all history reachable when only the current row matches", () => {
    expect(filterQuotationVersionGroups(groups, row => row.id === 38)[0].previous).toEqual([middle, old]);
    expect(filterQuotationVersionGroups(groups, () => false)).toEqual([]);
  });
  it("an old direct link overrides filters without changing the family root", () => {
    expect(filterQuotationVersionGroups(groups, () => false, 17)).toEqual(groups);
    expect(filterQuotationVersionGroups(groups, () => false, 999)).toEqual([]);
  });
  it("broken-chain direct links remain available as standalone evidence", () => {
    const fallback = groupQuotationVersions(rows, []);
    expect(filterQuotationVersionGroups(fallback, () => false, 17)).toEqual([{ current: old, previous: [] }]);
  });
  it("bulk candidates derived from main cards cannot include hidden previous versions", () => {
    expect(filterQuotationVersionGroups(groups, () => true).map(group => group.current.id)).toEqual([38]);
  });
});
