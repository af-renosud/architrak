import { describe, expect, it } from "vitest";
import { createCorrectionLine, correctionFinancialIssues } from "../architect-correction-model";
import { mergeQuotationDraft } from "../quotation-three-way";
import type { ArchitectCorrectionDraft } from "../architect-correction-model";

function fixture(): ArchitectCorrectionDraft {
  return { headerFr: "Avant", headerEn: "Before", explanationFr: "", explanationEn: "", summaryEn: "", discountHt: "0.00",
    lines: [1, 2].map(id => ({ ...createCorrectionLine("priced", `row-${id}`), id, descriptionFr: `Ligne ${id}`, vatRate: "10", totalHt: "84.30" })) };
}
describe("working quotation three-way preservation", () => {
  it("preserves optional recovery provenance through concurrent context rebases", () => {
    const base = fixture(), mine = structuredClone(base), latest = structuredClone(base);
    mine.recoverySource = { attemptId: 17, sourceDigest: "a".repeat(64) };
    mine.lines[0].descriptionFr += "\n\nTexte récupéré";
    latest.summaryEn = "Concurrent context update";
    const merged = mergeQuotationDraft(base, mine, latest);
    expect(merged.conflicts).toEqual([]);
    expect(merged.draft.recoverySource).toEqual(mine.recoverySource);
    expect(merged.draft.summaryEn).toBe(latest.summaryEn);
    expect(merged.draft.lines[0].descriptionFr).toBe(mine.lines[0].descriptionFr);
  });
  it("combines nonoverlapping edits without overwriting foreign wording or financial values", () => {
    const base = fixture(), mine = structuredClone(base), latest = structuredClone(base);
    mine.headerFr = "Mon titre"; mine.lines[0].descriptionEn = "Human English";
    latest.summaryEn = "Another architect's summary"; latest.lines[1].totalHt = "96.17";
    const merged = mergeQuotationDraft(base, mine, latest);
    expect(merged.conflicts).toEqual([]);
    expect(merged.draft).toMatchObject({ headerFr: "Mon titre", summaryEn: "Another architect's summary" });
    expect(merged.draft.lines[0].descriptionEn).toBe("Human English");
    expect(merged.draft.lines[1].totalHt).toBe("96.17");
  });
  it("requires explicit choices only for actual overlapping changes", () => {
    const base = fixture(), mine = structuredClone(base), latest = structuredClone(base);
    mine.lines[0].descriptionEn = "My translation"; latest.lines[0].descriptionEn = "Foreign translation";
    latest.lines[1].descriptionFr = "Foreign French"; mine.summaryEn = "My overview";
    const result = mergeQuotationDraft(base, mine, latest);
    expect(result.conflicts.map(conflict => conflict.key)).toEqual(["id:1:descriptionEn"]);
    const resolved = mergeQuotationDraft(base, mine, latest, { "id:1:descriptionEn": "mine" });
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.draft.lines[0]).toMatchObject({ id: 1, descriptionEn: "My translation" });
    expect(resolved.draft.lines[1].descriptionFr).toBe("Foreign French");
    expect(resolved.draft.summaryEn).toBe("My overview");
  });
  it("retains stable equal-price row identities, local new context rows and foreign new rows", () => {
    const base = fixture(), mine = structuredClone(base), latest = structuredClone(base);
    mine.lines.reverse();
    mine.lines.push({ ...createCorrectionLine("context", "new-local"), descriptionFr: "Contexte" });
    latest.lines.push({ ...createCorrectionLine("context", "new-foreign"), id: 81, descriptionEn: "Foreign context" });
    latest.lines[0].descriptionEn = "Remote first row";
    const result = mergeQuotationDraft(base, mine, latest);
    expect(result.conflicts).toEqual([]);
    expect(result.draft.lines.map(row => row.id)).toEqual([2, 1, 81, null]);
    expect(result.draft.lines.find(row => row.id === 1)?.descriptionEn).toBe("Remote first row");
    expect(result.draft.lines.find(row => row.clientKey === "new-local")?.descriptionFr).toBe("Contexte");
  });
  it("does not fabricate missing figures or VAT while merging wording", () => {
    const base = fixture(); base.lines[0].vatRate = ""; base.lines[1].totalHt = "";
    const mine = structuredClone(base); mine.headerEn = "Revised English";
    const result = mergeQuotationDraft(base, mine, structuredClone(base));
    expect(correctionFinancialIssues(result.draft).map(issue => issue.key)).toEqual(["row-1", "row-2"]);
    expect(result.draft.lines[0].vatRate).toBe("");
    expect(result.draft.lines[1].totalHt).toBe("");
  });
});
