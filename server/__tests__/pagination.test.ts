import { describe, it, expect } from "vitest";
import { parsePagination, paged } from "../lib/pagination";

function fakeReq(query: Record<string, string>) {
  return { query } as any;
}

describe("parsePagination", () => {
  it("returns defaults when no params provided", () => {
    expect(parsePagination(fakeReq({}))).toEqual({ limit: 50, offset: 0 });
  });

  it("respects custom defaults", () => {
    expect(parsePagination(fakeReq({}), { defaultLimit: 25 })).toEqual({ limit: 25, offset: 0 });
  });

  it("clamps limit to maxLimit", () => {
    expect(parsePagination(fakeReq({ limit: "9999" }), { maxLimit: 100 })).toEqual({ limit: 100, offset: 0 });
  });

  it("ignores invalid limit/offset and uses defaults", () => {
    expect(parsePagination(fakeReq({ limit: "abc", offset: "-5" }))).toEqual({ limit: 50, offset: 0 });
  });

  it("floors fractional values", () => {
    expect(parsePagination(fakeReq({ limit: "10.7", offset: "3.9" }))).toEqual({ limit: 10, offset: 3 });
  });
});

describe("paged", () => {
  it("reports hasMore=true when items fill the requested page", () => {
    const out = paged([1, 2, 3], { limit: 3, offset: 0 });
    expect(out.pagination.hasMore).toBe(true);
  });

  it("reports hasMore=false on partial page", () => {
    const out = paged([1, 2], { limit: 5, offset: 0 });
    expect(out.pagination.hasMore).toBe(false);
  });
});
