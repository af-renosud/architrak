import { describe, it, expect } from "vitest";
import { insertMarcheSchema } from "../schema";

/**
 * Task #462 — boundary pins for the marché acompte-recoupment
 * configuration. Both the create and PATCH routes derive their body
 * schemas from `insertMarcheSchema` (`.omit({projectId})` / `.partial()`),
 * so these pins guard the exact validation both endpoints apply.
 *
 * The percent fields must be STRICT scale-2 decimal strings: parseFloat
 * would accept trailing junk ("10oops") that only explodes later at the DB
 * cast, and >2 decimals that numeric(5,2) silently rounds — 0.001 → 0.00
 * flips the percent rule into its "recover in full" fallback.
 */

const baseMarche = {
  projectId: 1,
  contractorId: 2,
  totalHt: "10000.00",
  totalTtc: "12000.00",
};

const parse = (extra: Record<string, unknown>) =>
  insertMarcheSchema.safeParse({ ...baseMarche, ...extra });

describe("insertMarcheSchema — TVA regime config (Task #463)", () => {
  it("accepts valid rates (0, 5.5, 10, 20, 100), null and omission", () => {
    for (const v of ["0", "5.5", "5.50", "10", "20", "20.00", "100", "100.00", null, undefined]) {
      expect(parse({ tvaRatePercent: v }).success).toBe(true);
    }
  });

  it("rejects junk, negative, >100 and >2-decimal rates", () => {
    for (const v of ["20oops", "-1", "100.01", "101", "20.005", "", "abc", "1e2"]) {
      expect(parse({ tvaRatePercent: v }).success).toBe(false);
    }
  });

  it("accepts the autoliquidation flag as a boolean", () => {
    expect(parse({ tvaAutoliquidation: true }).success).toBe(true);
    expect(parse({ tvaAutoliquidation: false }).success).toBe(true);
    expect(parse({ tvaAutoliquidation: "yes" }).success).toBe(false);
  });
});

describe("insertMarcheSchema — acompte recoupment config", () => {
  it("accepts an ordinary marché payload without any recoupment fields (existing flows unchanged)", () => {
    expect(insertMarcheSchema.safeParse(baseMarche).success).toBe(true);
  });

  it("accepts each valid rule and rejects unknown rules", () => {
    for (const rule of ["asap", "percent", "progress_threshold"]) {
      expect(parse({ acompteRecoupmentRule: rule }).success).toBe(true);
    }
    expect(parse({ acompteRecoupmentRule: "whenever" }).success).toBe(false);
    expect(parse({ acompteRecoupmentRule: "" }).success).toBe(false);
  });

  it("accepts valid percent boundaries (0.01, 100, 100.00, integers, nulls)", () => {
    for (const v of ["0.01", "10", "10.5", "100", "100.00"]) {
      expect(parse({ acompteRecoupmentRule: "percent", acompteRecoupmentPercent: v }).success).toBe(true);
    }
    expect(parse({ acompteRecoupmentRule: "percent", acompteRecoupmentPercent: null }).success).toBe(true);
  });

  it("rejects percent = 0 (would silently mean 'recover in full') and > 100", () => {
    expect(parse({ acompteRecoupmentPercent: "0" }).success).toBe(false);
    expect(parse({ acompteRecoupmentPercent: "0.00" }).success).toBe(false);
    expect(parse({ acompteRecoupmentPercent: "100.01" }).success).toBe(false);
    expect(parse({ acompteRecoupmentPercent: "999" }).success).toBe(false);
  });

  it("rejects trailing junk and non-numeric strings", () => {
    for (const v of ["10oops", "10.5x", " 10", "10 ", "1e2", "-10", "+10", "abc", "."]) {
      expect(parse({ acompteRecoupmentPercent: v }).success).toBe(false);
      expect(parse({ acompteRecoupmentThresholdPercent: v }).success).toBe(false);
    }
  });

  it("rejects more than 2 decimal places (DB rounding would change the value)", () => {
    expect(parse({ acompteRecoupmentPercent: "0.001" }).success).toBe(false);
    expect(parse({ acompteRecoupmentPercent: "10.005" }).success).toBe(false);
    expect(parse({ acompteRecoupmentThresholdPercent: "30.005" }).success).toBe(false);
  });

  it("threshold accepts 0 and 100 boundaries (inclusive), rejects out of range", () => {
    for (const v of ["0", "0.00", "30", "100", "100.00"]) {
      expect(parse({ acompteRecoupmentThresholdPercent: v }).success).toBe(true);
    }
    expect(parse({ acompteRecoupmentThresholdPercent: "100.01" }).success).toBe(false);
    expect(parse({ acompteRecoupmentThresholdPercent: null }).success).toBe(true);
  });

  it("PATCH shape (.partial()) keeps the same field validation", () => {
    const patchSchema = insertMarcheSchema.partial();
    expect(patchSchema.safeParse({ acompteRecoupmentRule: "percent", acompteRecoupmentPercent: "10.00" }).success).toBe(true);
    expect(patchSchema.safeParse({ acompteRecoupmentPercent: "10oops" }).success).toBe(false);
    expect(patchSchema.safeParse({ acompteRecoupmentRule: "bogus" }).success).toBe(false);
    // Ordinary PATCH of unrelated fields still valid.
    expect(patchSchema.safeParse({ status: "signed" }).success).toBe(true);
  });
});
