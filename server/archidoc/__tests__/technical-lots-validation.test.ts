import { describe, it, expect } from "vitest";
import {
  validateTechnicalLotsResponse,
  TechnicalLotsValidationError,
} from "../sync-client";

// ---------------------------------------------------------------------------
// Minimal valid fixture
// ---------------------------------------------------------------------------
const VALID_RESPONSE = {
  lots: [
    {
      id: "lot-1",
      code: "01",
      labelFr: "Gros œuvre",
      displayOrder: 1,
      isActive: true,
      deletedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-06-01T00:00:00.000Z",
    },
    {
      id: "lot-2",
      code: "02",
      labelFr: "Charpente",
      displayOrder: 2,
      isActive: false,
      deletedAt: "2024-05-01T00:00:00.000Z",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-05-01T00:00:00.000Z",
    },
  ],
  catalogue: {
    revision: 42,
    changedAt: "2024-06-01T00:00:00.000Z",
  },
};

describe("validateTechnicalLotsResponse", () => {
  // --- Happy path ---------------------------------------------------------

  it("accepts a valid response with mixed active/deleted lots", () => {
    const result = validateTechnicalLotsResponse(VALID_RESPONSE);
    expect(result.lots).toHaveLength(2);
    expect(result.catalogue.revision).toBe(42);
  });

  it("accepts an empty lots array (first catalogue)", () => {
    const result = validateTechnicalLotsResponse({
      lots: [],
      catalogue: { revision: 0, changedAt: "2024-01-01T00:00:00.000Z" },
    });
    expect(result.lots).toHaveLength(0);
  });

  it("returns null deletedAt for active lots", () => {
    const result = validateTechnicalLotsResponse(VALID_RESPONSE);
    expect(result.lots[0].deletedAt).toBeNull();
  });

  // --- Root-level structure -----------------------------------------------

  it("rejects null root", () => {
    expect(() => validateTechnicalLotsResponse(null)).toThrow(TechnicalLotsValidationError);
  });

  it("rejects an array root", () => {
    expect(() => validateTechnicalLotsResponse([])).toThrow(TechnicalLotsValidationError);
  });

  it("rejects missing lots key", () => {
    expect(() =>
      validateTechnicalLotsResponse({ catalogue: VALID_RESPONSE.catalogue }),
    ).toThrow(/unexpected shape/);
  });

  it("rejects unknown response, catalogue, and lot keys", () => {
    expect(() =>
      validateTechnicalLotsResponse({ ...VALID_RESPONSE, extra: true }),
    ).toThrow(/unknown: extra/);
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        catalogue: { ...VALID_RESPONSE.catalogue, extra: true },
      }),
    ).toThrow(/unknown: extra/);
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], extra: true }],
      }),
    ).toThrow(/unknown: extra/);
  });

  it("requires deletedAt to be present explicitly, even when null", () => {
    const { deletedAt: _deletedAt, ...withoutDeletedAt } = VALID_RESPONSE.lots[0];
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [withoutDeletedAt],
      }),
    ).toThrow(/missing: deletedAt/);
  });

  // --- Catalogue validation -----------------------------------------------

  it("rejects non-integer catalogue.revision", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        catalogue: { revision: 1.5, changedAt: "2024-01-01T00:00:00.000Z" },
      }),
    ).toThrow(/revision must be a non-negative integer/);
  });

  it("rejects negative catalogue.revision", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        catalogue: { revision: -1, changedAt: "2024-01-01T00:00:00.000Z" },
      }),
    ).toThrow(/revision must be a non-negative integer/);
  });

  it("rejects malformed catalogue.changedAt", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        catalogue: { revision: 1, changedAt: "not-a-date" },
      }),
    ).toThrow(/changedAt must be a valid ISO-8601/);
  });

  it("rejects blank catalogue.changedAt", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        catalogue: { revision: 1, changedAt: "" },
      }),
    ).toThrow(/changedAt must be a valid ISO-8601/);
  });

  // --- Lot-level validation -----------------------------------------------

  it("rejects blank lot id", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], id: "  " }],
      }),
    ).toThrow(/id must be a non-blank string/);
  });

  it("rejects lot ids that cannot fit the mirror key", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], id: "x".repeat(256) }],
      }),
    ).toThrow(/at most 255 characters/);
  });

  it("rejects parseable dates without a complete ISO timestamp and timezone", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        catalogue: { revision: 1, changedAt: "2024-01-01" },
      }),
    ).toThrow(/changedAt must be a valid ISO-8601/);
  });

  it("rejects impossible calendar dates that Date would normalize", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        catalogue: { revision: 1, changedAt: "2024-02-30T00:00:00.000Z" },
      }),
    ).toThrow(/changedAt must be a valid ISO-8601/);
  });

  it("rejects duplicate lot ids", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [VALID_RESPONSE.lots[0], { ...VALID_RESPONSE.lots[1], id: "lot-1" }],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects blank lot code", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], code: "" }],
      }),
    ).toThrow(/code must be a non-blank string/);
  });

  it("rejects duplicate lot codes", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [VALID_RESPONSE.lots[0], { ...VALID_RESPONSE.lots[1], code: "01" }],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects blank labelFr", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], labelFr: "  " }],
      }),
    ).toThrow(/labelFr must be a non-blank string/);
  });

  it("rejects negative displayOrder", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], displayOrder: -1 }],
      }),
    ).toThrow(/displayOrder must be a non-negative integer/);
  });

  it("rejects non-integer displayOrder", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], displayOrder: 1.5 }],
      }),
    ).toThrow(/displayOrder must be a non-negative integer/);
  });

  it("rejects non-boolean isActive", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], isActive: 1 }],
      }),
    ).toThrow(/isActive must be a boolean/);
  });

  it("rejects malformed deletedAt string", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[1], isActive: false, deletedAt: "2024-13-01" }],
      }),
    ).toThrow(/deletedAt must be null or a valid ISO-8601/);
  });

  it("rejects isActive=true with a deletedAt (contradiction)", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [
          {
            ...VALID_RESPONSE.lots[0],
            isActive: true,
            deletedAt: "2024-05-01T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/contradiction/);
  });

  it("rejects malformed createdAt", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], createdAt: "bad-date" }],
      }),
    ).toThrow(/createdAt must be a valid ISO-8601/);
  });

  it("rejects malformed updatedAt", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: [{ ...VALID_RESPONSE.lots[0], updatedAt: "" }],
      }),
    ).toThrow(/updatedAt must be a valid ISO-8601/);
  });

  it("rejects a lot that is not an object", () => {
    expect(() =>
      validateTechnicalLotsResponse({
        ...VALID_RESPONSE,
        lots: ["not-an-object"],
      }),
    ).toThrow(/must be an object/);
  });
});
