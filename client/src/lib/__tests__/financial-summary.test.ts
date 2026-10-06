import { describe, expect, it } from "vitest";
import { commitmentLabel, isSignedCommitment } from "../financial-summary";

describe("financial summary commitment display", () => {
  it("labels unsigned and inactive quotations distinctly", () => {
    expect(commitmentLabel({ commitmentEligible: false, commitmentStatus: "unsigned" })).toBe("Not signed — excluded from commitment");
    expect(commitmentLabel({ commitmentEligible: false, commitmentStatus: "inactive" })).toBe("Inactive — excluded from commitment");
  });

  it("only describes eligible signed rows as commitments", () => {
    expect(isSignedCommitment({ commitmentEligible: true, commitmentStatus: "signed" })).toBe(true);
    expect(isSignedCommitment({ commitmentEligible: false, commitmentStatus: "signed" })).toBe(false);
    expect(isSignedCommitment({ commitmentEligible: true, commitmentStatus: "unsigned" })).toBe(false);
    expect(commitmentLabel({ commitmentEligible: true, commitmentStatus: "signed" })).toBe("Signed commitment");
  });

  it("does not invent signature evidence for an older response", () => {
    expect(isSignedCommitment({})).toBe(false);
    expect(commitmentLabel({})).toBe("Commitment status unavailable");
  });
});
