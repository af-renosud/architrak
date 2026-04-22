import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../env", () => ({
  env: {
    // Lifecycle policy: 90-day idle ceiling (the primary lifecycle trigger
    // is "devis fully invoiced", handled by storage helpers tested below).
    DEVIS_CHECK_TOKEN_TTL_DAYS: 90,
  },
}));

const { storageMock } = vi.hoisted(() => ({
  storageMock: {
    revokeExpiredDevisCheckTokens: vi.fn(async () => 0),
    revokeDevisCheckTokensForFullyInvoicedDevis: vi.fn(async () => 0),
  },
}));

vi.mock("../../storage", () => ({
  storage: storageMock,
}));

import { computeTokenExpiry, isTokenExpired } from "../devis-checks";
import { runCleanup } from "../devis-check-token-cleanup";

describe("devis-checks token expiry", () => {
  it("computes expiry as N days after the given timestamp (90-day idle ceiling)", () => {
    const from = new Date("2026-01-01T12:00:00Z");
    const out = computeTokenExpiry(from);
    expect(out).not.toBeNull();
    expect(out!.toISOString()).toBe("2026-04-01T12:00:00.000Z");
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

describe("devis-check-token cleanup job", () => {
  beforeEach(() => {
    storageMock.revokeExpiredDevisCheckTokens.mockClear();
    storageMock.revokeDevisCheckTokensForFullyInvoicedDevis.mockClear();
  });

  it("runs both the idle-ceiling and fully-invoiced sweeps and returns their sum", async () => {
    storageMock.revokeExpiredDevisCheckTokens.mockResolvedValueOnce(2);
    storageMock.revokeDevisCheckTokensForFullyInvoicedDevis.mockResolvedValueOnce(3);
    const total = await runCleanup();
    expect(storageMock.revokeExpiredDevisCheckTokens).toHaveBeenCalledOnce();
    expect(storageMock.revokeDevisCheckTokensForFullyInvoicedDevis).toHaveBeenCalledOnce();
    expect(total).toBe(5);
  });

  it("swallows errors and returns 0 so the periodic timer keeps running", async () => {
    storageMock.revokeExpiredDevisCheckTokens.mockRejectedValueOnce(new Error("boom"));
    const total = await runCleanup();
    expect(total).toBe(0);
  });
});
