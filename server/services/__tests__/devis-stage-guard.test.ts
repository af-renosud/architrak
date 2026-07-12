import { describe, it, expect } from "vitest";
import {
  evaluateManualStageTransition,
  LINEAR_STAGE_ORDER,
} from "../devis-stage-guard.service";

/**
 * Task #257 — seal on the generic-PATCH signOffStage path.
 *
 * Pinned behaviours:
 *   (a) Forward moves into `sent_to_client` / `client_signed_off` are
 *       rejected with an English message + machine code.
 *   (b) Backward moves (operator corrections) stay allowed, including
 *       backward INTO a sealed stage (client_signed_off → sent_to_client).
 *   (c) Same-stage no-op writes are allowed.
 *   (d) A current stage outside the linear order (non-linear contract
 *       stages, garbage) is treated as forward — it cannot be used to
 *       sneak into a sealed stage.
 *   (e) All transitions into non-sealed stages are untouched by the guard.
 */
describe("evaluateManualStageTransition (Task #257 seal)", () => {
  it("rejects every forward jump into sent_to_client", () => {
    for (const from of ["received", "checked_internal", "approved_for_signing"]) {
      const v = evaluateManualStageTransition(from, "sent_to_client");
      expect(v).not.toBeNull();
      expect(v!.code).toBe("manual_send_sealed");
      expect(v!.message).toMatch(/Signature électronique/);
    }
  });

  it("rejects every forward jump into client_signed_off", () => {
    for (const from of [
      "received",
      "checked_internal",
      "approved_for_signing",
      "sent_to_client",
    ]) {
      const v = evaluateManualStageTransition(from, "client_signed_off");
      expect(v).not.toBeNull();
      expect(v!.code).toBe("manual_signoff_sealed");
      expect(v!.message).toMatch(/Archisign/);
    }
  });

  it("allows backward correction client_signed_off → sent_to_client", () => {
    expect(evaluateManualStageTransition("client_signed_off", "sent_to_client")).toBeNull();
  });

  it("allows same-stage no-op writes into sealed stages", () => {
    expect(evaluateManualStageTransition("sent_to_client", "sent_to_client")).toBeNull();
    expect(evaluateManualStageTransition("client_signed_off", "client_signed_off")).toBeNull();
  });

  it("treats non-linear/unknown current stages as forward (sealed)", () => {
    for (const from of ["client_rejected", "void", "client_agreed", "garbage_stage", ""]) {
      const send = evaluateManualStageTransition(from, "sent_to_client");
      expect(send?.code).toBe("manual_send_sealed");
      const signoff = evaluateManualStageTransition(from, "client_signed_off");
      expect(signoff?.code).toBe("manual_signoff_sealed");
    }
  });

  it("never touches transitions into non-sealed stages", () => {
    for (const from of LINEAR_STAGE_ORDER) {
      for (const to of ["received", "checked_internal", "approved_for_signing", "void"]) {
        expect(evaluateManualStageTransition(from, to)).toBeNull();
      }
    }
    // Backward off the sealed stages is a normal correction too.
    expect(evaluateManualStageTransition("sent_to_client", "approved_for_signing")).toBeNull();
  });
});
