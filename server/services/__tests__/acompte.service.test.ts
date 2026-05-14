import { describe, it, expect } from "vitest";
import { evaluateAcompteGate, nextAcompteState, type GateInputs } from "../acompte.service";
import { buildAcompteInsertFields } from "../devis-upload.service";

const baseGateInput = (over: Partial<GateInputs> = {}): GateInputs => ({
  acompteRequired: false,
  acompteState: "none",
  allowProgressBeforeAcompte: false,
  acompteAmountHt: null,
  acomptePercent: null,
  ...over,
});

describe("acompte.service — evaluateAcompteGate", () => {
  it("allows when no acompte is required (state 'none')", () => {
    expect(evaluateAcompteGate(baseGateInput())).toEqual({ blocked: false });
  });

  it("blocks when acompte required AND state is 'pending'", () => {
    const decision = evaluateAcompteGate(
      baseGateInput({ acompteRequired: true, acompteState: "pending", acompteAmountHt: "1500.00", acomptePercent: "30.00" }),
    );
    expect(decision.blocked).toBe(true);
    if (!decision.blocked) throw new Error("unreachable");
    expect(decision.code).toBe("acompte_unpaid");
    expect(decision.state).toBe("pending");
  });

  it("blocks when state is 'invoiced' (facture d'acompte received but unpaid)", () => {
    const decision = evaluateAcompteGate(
      baseGateInput({ acompteRequired: true, acompteState: "invoiced", acompteAmountHt: "1500.00" }),
    );
    expect(decision.blocked).toBe(true);
  });

  it("allows when state is 'paid'", () => {
    const decision = evaluateAcompteGate(
      baseGateInput({ acompteRequired: true, acompteState: "paid" }),
    );
    expect(decision.blocked).toBe(false);
  });

  it("allows when allowProgressBeforeAcompte override is true", () => {
    const decision = evaluateAcompteGate(
      baseGateInput({ acompteRequired: true, acompteState: "pending", allowProgressBeforeAcompte: true }),
    );
    expect(decision.blocked).toBe(false);
  });

  it("allows when caller explicitly creates the facture d'acompte (isAcompteInvoice)", () => {
    const decision = evaluateAcompteGate(
      baseGateInput({ acompteRequired: true, acompteState: "pending" }),
      { isAcompteInvoice: true },
    );
    expect(decision.blocked).toBe(false);
  });
});

describe("acompte.service — nextAcompteState", () => {
  it("link_invoice: pending -> invoiced", () => {
    expect(nextAcompteState("pending", "link_invoice")).toBe("invoiced");
  });

  it("link_invoice: invoiced is idempotent (returns invoiced)", () => {
    expect(nextAcompteState("invoiced", "link_invoice")).toBe("invoiced");
  });

  it("link_invoice: from 'none' is rejected", () => {
    expect(nextAcompteState("none", "link_invoice")).toBeNull();
  });

  it("link_invoice: from 'paid' is rejected (already past)", () => {
    expect(nextAcompteState("paid", "link_invoice")).toBeNull();
  });

  it("mark_paid: invoiced -> paid", () => {
    expect(nextAcompteState("invoiced", "mark_paid")).toBe("paid");
  });

  it("mark_paid: from 'pending' is rejected (must link facture d'acompte first)", () => {
    expect(nextAcompteState("pending", "mark_paid")).toBeNull();
  });

  it("mark_paid: from 'none' is rejected", () => {
    expect(nextAcompteState("none", "mark_paid")).toBeNull();
  });

  it("mark_paid: from 'paid' is rejected (already past)", () => {
    expect(nextAcompteState("paid", "mark_paid")).toBeNull();
  });

  it("mark_paid: from 'applied' is rejected (terminal)", () => {
    expect(nextAcompteState("applied", "mark_paid")).toBeNull();
  });

  it("link_invoice: from 'applied' is rejected (terminal)", () => {
    expect(nextAcompteState("applied", "link_invoice")).toBeNull();
  });
});

describe("devis-upload.service — buildAcompteInsertFields", () => {
  it("returns empty patch when acompte not required", () => {
    expect(buildAcompteInsertFields({ acompteRequired: false }, "5000.00")).toEqual({});
  });

  it("derives acompteAmountHt from percent x devisHt when only percent is given", () => {
    const patch = buildAcompteInsertFields(
      { acompteRequired: true, acomptePercent: 30 },
      "5000.00",
    );
    expect(patch.acompteRequired).toBe(true);
    expect(patch.acomptePercent).toBe("30");
    expect(patch.acompteAmountHt).toBe("1500");
    expect(patch.acompteState).toBe("pending");
  });

  it("uses extracted acompteAmountHt verbatim when provided (rounded)", () => {
    const patch = buildAcompteInsertFields(
      { acompteRequired: true, acomptePercent: 30, acompteAmountHt: 1499.999 },
      "5000.00",
    );
    expect(patch.acompteAmountHt).toBe("1500");
  });

  it("captures the verbatim trigger phrase, trimmed", () => {
    const patch = buildAcompteInsertFields(
      { acompteRequired: true, acomptePercent: 30, acompteTrigger: "  Acompte de 30% à la commande  " },
      "5000.00",
    );
    expect(patch.acompteTrigger).toBe("Acompte de 30% à la commande");
  });

  it("rejects out-of-range percentages (>100 or <=0)", () => {
    const patch = buildAcompteInsertFields(
      { acompteRequired: true, acomptePercent: 150 },
      "5000.00",
    );
    expect(patch.acomptePercent).toBeNull();
    expect(patch.acompteAmountHt).toBeNull();
  });

  it("starts state at 'pending' even when no amount could be derived", () => {
    const patch = buildAcompteInsertFields(
      { acompteRequired: true },
      "5000.00",
    );
    expect(patch.acompteState).toBe("pending");
    expect(patch.acompteAmountHt).toBeNull();
  });
});
