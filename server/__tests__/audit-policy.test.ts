import { describe, it, expect } from "vitest";
import { assessAudit, PICOMATCH_EXCEPTION } from "../../script/audit-policy";

const date = new Date("2026-11-18T00:00:00Z");
function report() {
  return {
    metadata: { vulnerabilities: { high: 2, critical: 0 } },
    vulnerabilities: {
      picomatch: { severity: "high", via: [{ name: "picomatch", url: PICOMATCH_EXCEPTION.url, severity: "high" }] },
      vite: { severity: "high", via: ["picomatch"] },
    },
  };
}
describe("temporary audit exception", () => {
  it("accepts only the exact advisory and its known dependency chain", () => {
    expect(assessAudit(report(), date)).toEqual({ blocking: [], accepted: ["picomatch", "vite"] });
  });
  it("expires without a grace period", () => {
    expect(assessAudit(report(), new Date(PICOMATCH_EXCEPTION.expiresAt)).blocking).toHaveLength(2);
  });
  it("does not accept another advisory on the same package", () => {
    const r = report();
    r.vulnerabilities.picomatch.via[0].url = "https://github.com/advisories/another";
    expect(assessAudit(r, date).blocking).toHaveLength(2);
  });
  it("does not accept critical escalation", () => {
    const r = report();
    r.vulnerabilities.picomatch.severity = "critical";
    r.metadata.vulnerabilities = { high: 1, critical: 1 };
    expect(assessAudit(r, date).blocking).toHaveLength(2);
  });
  it("fails closed for malformed reports", () => {
    expect(() => assessAudit({}, date)).toThrow();
    const r = report();
    r.metadata.vulnerabilities.high = 3;
    expect(() => assessAudit(r, date)).toThrow();
  });
});
