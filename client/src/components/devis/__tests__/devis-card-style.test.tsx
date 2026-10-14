// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { devisCardClassName, signedDevisFirst } from "../devis-card-style";
import type { QuotationCommitmentEvidence } from "@shared/quotation-commitment";

afterEach(cleanup);

describe("signed-first displayed order", () => {
  const unsigned = { id: 1, accountingState: "active", signOffStage: "sent_to_client" };
  const integrated = { id: 2, accountingState: "active", archisignEnvelopeStatus: "signed" };
  const manual = { id: 3, accountingState: "active", signedOffVia: "manual_upload", manualSignoffAt: "2026-06-18" };
  const voided = { ...integrated, id: 4, status: "void" };
  const replaced = { ...manual, id: 5, accountingState: "superseded" };

  it("stably partitions mixed records without mutating the input or replacing identities", () => {
    const input = Object.freeze([unsigned, voided, manual, replaced, integrated]);
    const ordered = signedDevisFirst(input);
    expect(ordered).toEqual([manual, integrated, unsigned, voided, replaced]);
    expect(input).toEqual([unsigned, voided, manual, replaced, integrated]);
    expect(ordered[0]).toBe(manual);
    expect(ordered[4]).toBe(replaced);
  });

  it("preserves unsigned and inactive order, including empty lists", () => {
    const input = Object.freeze([voided, unsigned, replaced]);
    expect(signedDevisFirst(input)).toEqual(input);
    expect(signedDevisFirst(input)).not.toBe(input);
    expect(signedDevisFirst([])).toEqual([]);
  });

  it("only reorders the filtered subset, never restoring hidden records", () => {
    const filtered = [unsigned, integrated, manual].filter(d => d.id !== manual.id);
    expect(signedDevisFirst(filtered)).toEqual([integrated, unsigned]);
  });

  it("reclassifies refreshed signature and replacement status on the next render", () => {
    const input = [unsigned, { ...manual, manualSignoffAt: null }, integrated];
    expect(signedDevisFirst(input).map(d => d.id)).toEqual([2, 1, 3]);
    const refreshed = [unsigned, manual, integrated];
    expect(signedDevisFirst(refreshed).map(d => d.id)).toEqual([3, 2, 1]);
    const retired = [unsigned, replaced, { ...integrated, status: "void" }];
    expect(signedDevisFirst(retired).map(d => d.id)).toEqual([1, 5, 2]);
  });
});

const signatures: Array<[string, QuotationCommitmentEvidence]> = [
  ["integrated envelope", { archisignEnvelopeStatus: "signed" }],
  ["client sign-off stage", { signOffStage: "client_signed_off" }],
  ["manually recorded copy", { signedOffVia: "manual_upload", manualSignoffAt: "2026-06-18" }],
  ["durable signed PDF after stage rollback", { signedPdfStorageKey: "signed/devis.pdf", signOffStage: "approved_for_signing" }],
  ["legacy signed status", { status: "signed" }],
];

function card(devis: QuotationCommitmentEvidence, expanded: boolean) {
  render(
    <LuxuryCard data-testid="card" className={devisCardClassName(devis, expanded)}>
      Quotation
    </LuxuryCard>,
  );
  return screen.getByTestId("card");
}

describe.each([false, true])("devis card frame (expanded=%s)", (expanded) => {
  it.each(signatures)("uses a full 3px green border for %s", (_, evidence) => {
    const element = card({ accountingState: "active", ...evidence }, expanded);
    expect(element.classList.contains("border-[3px]")).toBe(true);
    expect(element.classList.contains("border-green-600")).toBe(true);
    expect(element.classList.contains("dark:border-green-600")).toBe(true);
    expect(element.classList.contains("border-2")).toBe(false);
    expect(element.className).not.toContain("border-[#0B2545]");
    expect(element.className).not.toContain("border-[rgba");
  });

  it.each([
    ["void", { status: "void" }],
    ["cancelled", { status: "cancelled" }],
    ["replaced", { accountingState: "superseded" }],
    ["superseded status", { status: "superseded" }],
    ["inactive accounting", { accountingState: "inactive" }],
  ] satisfies Array<[string, QuotationCommitmentEvidence]>)("does not highlight %s despite signed evidence", (_, inactive) => {
    const element = card({
      accountingState: "active",
      signOffStage: "client_signed_off",
      archisignEnvelopeStatus: "signed",
      signedPdfStorageKey: "signed/devis.pdf",
      signedOffVia: "manual_upload",
      manualSignoffAt: "2026-06-18",
      ...inactive,
    }, expanded);
    expect(element.className).not.toContain("green-600");
    expect(element.className).not.toContain("border-[3px]");
  });

  it.each(["received", "approved_for_signing", "sent_to_client", "client_rejected", "void"])(
    "preserves unsigned styling at stage %s",
    (signOffStage) => {
      const element = card({ accountingState: "active", signOffStage }, expanded);
      expect(element.className).not.toContain("green-600");
      expect(element.classList.contains("border-2")).toBe(expanded);
      expect(devisCardClassName({ accountingState: "active", signOffStage }, expanded)).toBe(
        expanded
          ? "border-2 border-[#0B2545]/40 dark:border-[#0B2545]/60 shadow-[0_2px_8px_rgba(11,37,69,0.08)] transition-[border-color,box-shadow] duration-150"
          : "transition-[border-color,box-shadow] duration-150",
      );
    },
  );
});
