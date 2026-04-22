import { describe, it, expect } from "vitest";
import {
  computeLapsingBannerState,
  LAPSING_THRESHOLD_DAYS,
} from "../DevisTab";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-01-15T12:00:00.000Z");

function tokenWithExpiry(expiresAt: Date | string | null, opts: { revokedAt?: Date | null } = {}) {
  return {
    expiresAt,
    revokedAt: opts.revokedAt ?? null,
  };
}

describe("computeLapsingBannerState (Task #95 — lapsing-token banner)", () => {
  describe("suppression", () => {
    it("returns null when token is null/undefined", () => {
      expect(computeLapsingBannerState(null, NOW)).toBeNull();
      expect(computeLapsingBannerState(undefined, NOW)).toBeNull();
    });

    it("returns null when token is revoked (lifecycle revoke covers fully-invoiced devis)", () => {
      const expiresAt = new Date(NOW.getTime() + 2 * MS_PER_DAY);
      const t = tokenWithExpiry(expiresAt, { revokedAt: new Date(NOW.getTime() - 1000) });
      expect(computeLapsingBannerState(t, NOW)).toBeNull();
    });

    it("returns null when token has no expiry (TTL disabled)", () => {
      expect(computeLapsingBannerState(tokenWithExpiry(null), NOW)).toBeNull();
    });

    it("returns null for already-expired tokens (handled by TokenPanel + must be re-issued)", () => {
      const expiresAt = new Date(NOW.getTime() - MS_PER_DAY);
      expect(computeLapsingBannerState(tokenWithExpiry(expiresAt), NOW)).toBeNull();
    });

    it("returns null when expiry is exactly now (msRemaining = 0)", () => {
      expect(computeLapsingBannerState(tokenWithExpiry(NOW), NOW)).toBeNull();
    });

    it("returns null when expiry is further out than the 7-day threshold", () => {
      const expiresAt = new Date(NOW.getTime() + (LAPSING_THRESHOLD_DAYS + 1) * MS_PER_DAY);
      expect(computeLapsingBannerState(tokenWithExpiry(expiresAt), NOW)).toBeNull();
    });

    it("returns null when expiry is unparseable", () => {
      expect(computeLapsingBannerState(tokenWithExpiry("not-a-date" as unknown as string), NOW)).toBeNull();
    });
  });

  describe("threshold edge", () => {
    it("renders for an expiry exactly at the threshold (7 days)", () => {
      const expiresAt = new Date(NOW.getTime() + 7 * MS_PER_DAY);
      const state = computeLapsingBannerState(tokenWithExpiry(expiresAt), NOW);
      expect(state).not.toBeNull();
      expect(state!.daysRemaining).toBe(7);
      expect(state!.copy).toBe("Le lien partagé avec l'entreprise expire dans 7 jours.");
    });

    it("renders just inside the threshold (6.5 days → ceil to 7)", () => {
      const expiresAt = new Date(NOW.getTime() + 6.5 * MS_PER_DAY);
      const state = computeLapsingBannerState(tokenWithExpiry(expiresAt), NOW);
      expect(state).not.toBeNull();
      expect(state!.daysRemaining).toBe(7);
    });
  });

  describe("singular vs plural copy", () => {
    it("renders singular '1 jour' when expiry is within 24h", () => {
      const expiresAt = new Date(NOW.getTime() + 6 * 60 * 60 * 1000); // 6 hours
      const state = computeLapsingBannerState(tokenWithExpiry(expiresAt), NOW);
      expect(state).not.toBeNull();
      expect(state!.daysRemaining).toBe(1);
      expect(state!.copy).toBe("Le lien partagé avec l'entreprise expire dans 1 jour.");
    });

    it("renders singular '1 jour' for an expiry exactly 1 day out", () => {
      const expiresAt = new Date(NOW.getTime() + MS_PER_DAY);
      const state = computeLapsingBannerState(tokenWithExpiry(expiresAt), NOW);
      expect(state).not.toBeNull();
      expect(state!.daysRemaining).toBe(1);
      expect(state!.copy).toBe("Le lien partagé avec l'entreprise expire dans 1 jour.");
    });

    it("renders plural 'X jours' for any expiry > 1 day out", () => {
      const expiresAt = new Date(NOW.getTime() + 3.2 * MS_PER_DAY);
      const state = computeLapsingBannerState(tokenWithExpiry(expiresAt), NOW);
      expect(state).not.toBeNull();
      expect(state!.daysRemaining).toBe(4);
      expect(state!.copy).toBe("Le lien partagé avec l'entreprise expire dans 4 jours.");
    });
  });

  describe("custom threshold", () => {
    it("respects a caller-supplied threshold (forward compatibility for #96)", () => {
      const expiresAt = new Date(NOW.getTime() + 10 * MS_PER_DAY);
      // Default 7-day threshold suppresses
      expect(computeLapsingBannerState(tokenWithExpiry(expiresAt), NOW)).toBeNull();
      // 14-day threshold renders
      const state = computeLapsingBannerState(tokenWithExpiry(expiresAt), NOW, 14);
      expect(state).not.toBeNull();
      expect(state!.daysRemaining).toBe(10);
    });
  });
});
