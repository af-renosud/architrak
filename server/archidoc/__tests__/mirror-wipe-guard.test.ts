import { describe, it, expect } from "vitest";
import { wipeGuardVerdict } from "../sync-service";

// The wipe guard protects the mirror from an empty/truncated upstream
// response soft-deleting every row during full-sync reconciliation.
describe("wipeGuardVerdict", () => {
  it("refuses deleting all active rows (empty upstream response)", () => {
    expect(wipeGuardVerdict("projects", 6, 6, 0)).toMatch(/Refused to soft-delete 6 of 6/);
  });

  it("refuses deleting >=90% of a mirror with at least 5 rows", () => {
    expect(wipeGuardVerdict("projects", 10, 9, 1)).toMatch(/Refused/);
  });

  it("allows normal partial reconciliation", () => {
    expect(wipeGuardVerdict("projects", 10, 3, 7)).toBeNull();
  });

  it("allows wiping a tiny mirror only when below the all-rows case", () => {
    // 4 active rows, deleting 3 (75%) — under ratio guard threshold rows and not all
    expect(wipeGuardVerdict("projects", 4, 3, 1)).toBeNull();
    // deleting all 4 is still refused
    expect(wipeGuardVerdict("projects", 4, 4, 0)).toMatch(/Refused/);
  });

  it("is a no-op when nothing would be deleted or mirror is empty", () => {
    expect(wipeGuardVerdict("projects", 0, 0, 0)).toBeNull();
    expect(wipeGuardVerdict("projects", 10, 0, 10)).toBeNull();
  });
});
