import { describe, expect, it } from "vitest";
import { correctionCents, correctionMoney, correctionProduct, createCorrectionLine, previewCorrectionTotals, reorderCorrectionLine, transferCorrectionPassage } from "../architect-correction-model";
import type { ArchitectCorrectionDraft, ArchitectCorrectionLine } from "../architect-correction-model";

const line = (id: number, amount: string, vat: string): ArchitectCorrectionLine => ({
  ...createCorrectionLine("priced", `line-${id}`), id, descriptionFr: `Specification ${id}`,
  totalHt: amount, vatRate: vat, unitPriceHt: amount, quantity: "1",
});
const draft = (lines: ArchitectCorrectionLine[], discountHt = "0.00"): ArchitectCorrectionDraft =>
  ({ headerFr: "", headerEn: "", explanationFr: "", explanationEn: "", summaryEn: "", discountHt, lines });

describe("architect correction exact-cent advisory arithmetic", () => {
  it("calculates fractional quantities without float drift", () => {
    expect(correctionProduct("0.125", "119.96")).toBe("15.00");
    expect(correctionProduct("1.5", "0.01")).toBe("0.02");
    expect(correctionMoney(correctionCents("219.985"))).toBe("219.99");
    expect(correctionMoney(correctionCents("-219.985"))).toBe("-219.99");
  });
  it("uses mixed VAT, exempt items and proportionate document discount", () => {
    expect(previewCorrectionTotals(draft([
      line(1, "1795.00", "20"), line(2, "1795.00", "10"), line(3, "915.00", "5.5"), line(4, "84.17", "0"),
    ], "73.29"))).toEqual({ ht: "4515.88", vat: "579.42", ttc: "5095.30" });
  });
  it("excludes unaccepted options and contextual descriptions from charges", () => {
    const option = { ...line(2, "147.39", "20"), included: false };
    const context = { ...createCorrectionLine("context", "context"), totalHt: "999.00", vatRate: "" };
    expect(previewCorrectionTotals(draft([line(1, "102.13", "5.5"), option, context])))
      .toEqual({ ht: "102.13", vat: "5.62", ttc: "107.75" });
  });
  it("never assumes 20% for missing VAT or adds a balancing adjustment", () => {
    expect(() => previewCorrectionTotals(draft([line(1, "0.10", "")]))).toThrow("valid decimal");
    expect(() => previewCorrectionTotals(draft([line(1, "0.10", "10")], "0.11"))).toThrow("discount");
    expect(previewCorrectionTotals(draft([line(1, "0.05", "10"), line(2, "0.05", "10")])))
      .toEqual({ ht: "0.10", vat: "0.01", ttc: "0.11" });
  });
  it("retains a one-cent TTC discrepancy", () => {
    const result = previewCorrectionTotals(draft([line(1, "1915.01", "0")]));
    expect(correctionMoney(correctionCents(result.ttc) - correctionCents("1915.00"))).toBe("0.01");
  });
  it("uses explicit line-level rounding and deterministic discount allocation after reorder", () => {
    const source = draft([line(1, "0.05", "10"),line(2, "0.05", "10")]);
    expect(previewCorrectionTotals({ ...source,vatRounding: "line" }).vat).toBe("0.02");
    expect(previewCorrectionTotals(source).vat).toBe("0.01");
    const mixed = draft([line(1, "1.03", "20"),line(2, "1.03", "5.5")], "0.01");
    expect(previewCorrectionTotals(mixed)).toEqual(previewCorrectionTotals({ ...mixed,lines: [...mixed.lines].reverse() }));
  });
});
describe("description identity and non-destructive realignment", () => {
  it("reorders stable identities without reassigning amounts", () => {
    const lines = [line(712, "1795.00", "10"), line(819, "1795.00", "10"), line(935, "915.00", "10")];
    const reordered = reorderCorrectionLine(lines, 2, 0);
    expect(reordered.map(row => row.id)).toEqual([935, 712, 819]);
    expect(reordered.find(row => row.id === 935)?.totalHt).toBe("915.00");
    expect(lines.map(row => row.id)).toEqual([712, 819, 935]);
  });
  it("moves selected passages only; English, money and IDs remain on their rows", () => {
    const source = { ...line(1, "1795.00", "10"), descriptionFr: "Door A.\nSpecification B.", descriptionEn: "Manually reviewed A" };
    const target = { ...line(2, "1795.00", "10"), descriptionFr: "Door B.", descriptionEn: "Manually reviewed B" };
    const moved = transferCorrectionPassage([source, target], 0, 1, 8, source.descriptionFr.length, true);
    expect(moved[0].descriptionFr).toBe("Door A.\n");
    expect(moved[1].descriptionFr).toBe("Door B.\n\nSpecification B.");
    expect(moved[0].descriptionEn).toBe(source.descriptionEn);
    expect(moved[1].descriptionEn).toBe(target.descriptionEn);
    expect(moved.map(({ id, totalHt }) => ({ id, totalHt }))).toEqual([{ id: 1, totalHt: "1795.00" }, { id: 2, totalHt: "1795.00" }]);
  });
  it("copies without modifying source and refuses invalid/self transfers", () => {
    const lines = [line(1, "68.12", "10"), line(2, "123.45", "20")];
    expect(transferCorrectionPassage(lines, 0, 1, 0, lines[0].descriptionFr.length, false)[0]).toEqual(lines[0]);
    expect(transferCorrectionPassage(lines, 0, 0, 0, 4, true)).toBe(lines);
    expect(transferCorrectionPassage(lines, 0, 1, -1, 4, true)).toBe(lines);
  });
});
