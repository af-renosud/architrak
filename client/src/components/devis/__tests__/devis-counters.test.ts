import { describe, expect, it } from "vitest";
import { countDevisSignOff, TERMINAL_SIGN_OFF_STAGES } from "../devis-counters";

// Task #545 — the Devis tab "Signed" counter used to compare signOffStage
// against "signed", a value that does not exist in SIGN_OFF_STAGES, so it
// always showed 0. These tests pin the corrected semantics.
describe("countDevisSignOff", () => {
  it("counts a client_signed_off devis as Signed, not Pending", () => {
    const { pendingDevisCount, signedDevisCount } = countDevisSignOff([
      { signOffStage: "client_signed_off" },
    ]);
    expect(signedDevisCount).toBe(1);
    expect(pendingDevisCount).toBe(0);
  });

  it("counts in-workflow stages as Pending", () => {
    const stages = [
      "received",
      "checked_internal",
      "client_review_in_progress",
      "client_agreed",
      "approved_for_signing",
      "sent_to_client",
    ];
    const { pendingDevisCount, signedDevisCount } = countDevisSignOff(
      stages.map(signOffStage => ({ signOffStage })),
    );
    expect(pendingDevisCount).toBe(stages.length);
    expect(signedDevisCount).toBe(0);
  });

  it("terminal negative stages are neither Pending nor Signed", () => {
    const { pendingDevisCount, signedDevisCount } = countDevisSignOff([
      { signOffStage: "client_rejected" },
      { signOffStage: "void" },
    ]);
    expect(pendingDevisCount).toBe(0);
    expect(signedDevisCount).toBe(0);
  });

  it("mixed set: prod repro (one signed-off devis) shows Signed 1 / Pending 0", () => {
    const { pendingDevisCount, signedDevisCount } = countDevisSignOff([
      { signOffStage: "client_signed_off" },
    ]);
    expect(signedDevisCount).toBe(1);
    expect(pendingDevisCount).toBe(0);
  });

  it("the nonexistent 'signed' stage is not a terminal stage", () => {
    expect(TERMINAL_SIGN_OFF_STAGES).not.toContain("signed");
  });
});
