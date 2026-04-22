import { describe, it, expect, vi } from "vitest";

vi.mock("../../env", () => ({
  env: {
    DEVIS_CHECK_TOKEN_TTL_DAYS: 30,
  },
}));

vi.mock("../../storage", () => ({
  storage: {},
}));

import { computeTokenExpiry, isTokenExpired } from "../devis-checks";

describe("devis-checks token expiry", () => {
  it("computes expiry as N days after the given timestamp", () => {
    const from = new Date("2026-01-01T12:00:00Z");
    const out = computeTokenExpiry(from);
    expect(out).not.toBeNull();
    expect(out!.toISOString()).toBe("2026-01-31T12:00:00.000Z");
  });

  it("treats tokens past their expiresAt as expired", () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    expect(isTokenExpired({ expiresAt: past })).toBe(true);
    expect(isTokenExpired({ expiresAt: future })).toBe(false);
  });

  it("treats tokens with no expiresAt as never expired", () => {
    expect(isTokenExpired({ expiresAt: null })).toBe(false);
  });
});
