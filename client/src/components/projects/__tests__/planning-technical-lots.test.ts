import { describe, expect, it } from "vitest";
import {
  deriveTechnicalLotsUiState,
  type TechnicalLotsResponse,
} from "../planning-technical-lots";

function response(
  state: "ready" | "last_known_good" | "empty",
): TechnicalLotsResponse {
  const hasCatalogue = state !== "empty";
  return {
    lots: hasCatalogue
      ? [{ id: "lot-1", code: "01", labelFr: "Structure", displayOrder: 1, isActive: true, deletedAt: null }]
      : [],
    catalogue: hasCatalogue
      ? { revision: 4, changedAt: "2026-08-22T10:00:00.000Z" }
      : null,
    sync: {
      status: state === "last_known_good" ? "failed" : "completed",
      errorMessage: state === "last_known_good" ? "Refresh failed safely." : null,
    },
    availability: {
      state,
      selectable: hasCatalogue,
      reason: state === "ready" ? null : "Safe diagnostic reason.",
      lotCount: hasCatalogue ? 1 : 0,
      activeLotCount: hasCatalogue ? 1 : 0,
      revision: hasCatalogue ? 4 : null,
      changedAt: hasCatalogue ? "2026-08-22T10:00:00.000Z" : null,
      syncedAt: hasCatalogue ? "2026-08-22T10:01:00.000Z" : null,
      lastFetch: null,
    },
  };
}

describe("Planning technical-lot catalogue UI state", () => {
  it("enables the selector for a validated current catalogue", () => {
    expect(deriveTechnicalLotsUiState(response("ready"), null)).toMatchObject({
      catalogueSelectable: true,
      catalogueColdFailure: false,
      catalogueStale: false,
    });
  });

  it("keeps last-known-good choices selectable after a failed refresh", () => {
    expect(deriveTechnicalLotsUiState(response("last_known_good"), null)).toEqual({
      catalogueSelectable: true,
      catalogueColdFailure: false,
      catalogueStale: true,
      diagnosticReason: "Safe diagnostic reason.",
    });
  });

  it("disables selection when the first load has no validated cache", () => {
    expect(deriveTechnicalLotsUiState(response("empty"), null)).toEqual({
      catalogueSelectable: false,
      catalogueColdFailure: true,
      catalogueStale: false,
      diagnosticReason: "Safe diagnostic reason.",
    });
  });

  it("disables selection after a cold query failure without pretending stale data exists", () => {
    expect(deriveTechnicalLotsUiState(undefined, new Error("request failed"))).toMatchObject({
      catalogueSelectable: false,
      catalogueColdFailure: true,
      catalogueStale: false,
    });
  });
});