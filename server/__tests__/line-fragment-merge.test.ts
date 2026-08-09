import { describe, it, expect, vi } from "vitest";

// Task #356 — continuation-paragraph fragment handling.
//
// Prod DVP0000661: the AI split the PDF's item 6 in two — the continuation
// paragraph ("Inspection, relevé de cotes…") became a phantom numbered line
// with no price, shifting every later line number and desynchronising the
// translation tab. These tests pin the deterministic merge pass, the advisory
// for surviving fragments, and the repair transforms.

import {
  mergeContinuationFragments,
  isContinuationFragment,
  checkFragmentLines,
  LEADING_ITEM_REF,
} from "../services/extraction-completeness";
import {
  applyFragmentMergeToExtractedItems,
  applyFragmentMergeToTranslations,
} from "../services/line-fragment-repair.service";
import { validateExtraction } from "../services/extraction-validator";
import { deriveAdvisoryCode, ADVISORY_CODES } from "../../shared/advisory-codes";
import type { DevisTranslationLine } from "@shared/schema";

const PRIMARY = {
  description: "Ps.11-ps.22 préparation bassin\npréparation complète du bassin avant pose du pvc armé, comprenant",
  quantity: 1,
  unit: "ens",
  unitPrice: 3513.6,
  total: 3513.6,
  pageHint: 1,
  bbox: { x: 0.1, y: 0.5, w: 0.8, h: 0.05 },
};
const FRAGMENT = {
  description: "Inspection, relevé de cotes, nettoyage, ponçage, sondage des supports, purge des zones non adhérentes et reprises ponctuelles au mortier adapté.\nRagréage/lissage général des supports selon état constaté après dépose, nettoyage final et évacuation des déchets.",
  quantity: 1,
  pageHint: 2,
};
const NEXT = { description: "Ps.25 pose de deux skimmers", total: 3113.88, pageHint: 2 };

describe("mergeContinuationFragments — DVP0000661 shape", () => {
  it("folds the continuation paragraph into the previous item, keeping its amounts and geometry", () => {
    const { lineItems, mergedIndices } = mergeContinuationFragments([PRIMARY, FRAGMENT, NEXT]);
    expect(mergedIndices).toEqual([1]);
    expect(lineItems).toHaveLength(2);
    expect(lineItems[0].description).toContain("comprenant");
    expect(lineItems[0].description).toContain("Inspection, relevé de cotes");
    expect(lineItems[0].description).toContain("évacuation des déchets");
    expect(lineItems[0].total).toBe(3513.6);
    expect(lineItems[0].pageHint).toBe(1);
    expect(lineItems[0].bbox).toEqual(PRIMARY.bbox);
    expect(lineItems[1].description).toBe("Ps.25 pose de deux skimmers");
  });

  it("does NOT merge a zero-priced line that carries its own item/lot reference", () => {
    const freebie = { description: "Ps.07 forfait recherche de fuite offert", total: 0 };
    const { lineItems, mergedIndices } = mergeContinuationFragments([PRIMARY, freebie]);
    expect(mergedIndices).toEqual([]);
    expect(lineItems).toHaveLength(2);
  });

  it("does NOT merge when the previous description ends closed (no colon/comma/connector)", () => {
    const closedPrev = { description: "Dm.03 dépose du réseau hydraulique piscine et terrassements associés.", total: 980.88 };
    const orphan = { description: "Nettoyage final du chantier" };
    const { mergedIndices } = mergeContinuationFragments([closedPrev, orphan]);
    expect(mergedIndices).toEqual([]);
  });

  it("does NOT merge a priced line even after an open-ended predecessor", () => {
    const priced = { description: "Nettoyage final et évacuation", total: 450 };
    const { mergedIndices } = mergeContinuationFragments([PRIMARY, priced]);
    expect(mergedIndices).toEqual([]);
  });

  it("merges chained fragments into the same primary line and drops empty rows", () => {
    const openFragment = { description: "Inspection et relevé de cotes, comprenant :" };
    const secondFragment = { description: "purge des zones non adhérentes" };
    const empty = { description: "  " };
    const { lineItems, mergedIndices } = mergeContinuationFragments([PRIMARY, openFragment, secondFragment, empty, NEXT]);
    expect(mergedIndices).toEqual([1, 2, 3]);
    expect(lineItems).toHaveLength(2);
    expect(lineItems[0].description).toContain("purge des zones non adhérentes");
  });

  it("never merges the first line (no predecessor)", () => {
    expect(isContinuationFragment({ description: "texte sans prix" }, undefined)).toBe(false);
  });
});

describe("LEADING_ITEM_REF", () => {
  it("recognises lot-code and numbered references", () => {
    for (const d of ["GO.05 installation", "Ps.11-ps.22 préparation", "DM.04 démolition", "1. Terrassement", "24) Peinture", "3.2 - Cloisons"]) {
      expect(LEADING_ITEM_REF.test(d)).toBe(true);
    }
  });
  it("rejects continuation prose", () => {
    for (const d of ["Inspection, relevé de cotes", "purge des zones non adhérentes", "Ragréage/lissage général"]) {
      expect(LEADING_ITEM_REF.test(d)).toBe(false);
    }
  });
});

describe("checkFragmentLines advisory + code mapping", () => {
  it("flags a surviving zero-priced reference-less line as a warning with a stable code", () => {
    const closedPrev = { description: "Dm.03 dépose du réseau hydraulique.", total: 980.88 };
    const orphan = { description: "Nettoyage final du chantier" };
    const warnings = checkFragmentLines([closedPrev, orphan]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe("warning");
    expect(warnings[0].field).toBe("lineFragment");
    expect(deriveAdvisoryCode(warnings[0])).toBe(ADVISORY_CODES.LINE_FRAGMENT_SUSPECTED);
  });

  it("does not flag referenced or priced lines, and surfaces through validateExtraction", () => {
    expect(checkFragmentLines([PRIMARY, NEXT])).toHaveLength(0);
    const result = validateExtraction({
      documentType: "quotation",
      amountHt: 4494.48,
      amountTtc: 5393.38,
      tvaAmount: 898.9,
      lineItems: [
        { description: "Dm.03 dépose du réseau.", total: 980.88 },
        { description: "Nettoyage final du chantier" },
        { description: "Ps.25 pose de deux skimmers", total: 3513.6 },
      ],
    });
    expect(result.warnings.some((w) => w.field === "lineFragment")).toBe(true);
    // Advisory only — a suspected fragment must not hard-block on its own.
    expect(result.warnings.find((w) => w.field === "lineFragment")!.severity).toBe("warning");
  });
});

describe("repair transforms (pure)", () => {
  it("applyFragmentMergeToExtractedItems merges index N into N-1, keeping primary amounts", () => {
    const items = [
      { description: "A", total: 1 },
      { description: "Primary, comprenant", total: 3513.6 },
      { description: "fragment text", total: 0 },
      { description: "B", total: 2 },
    ];
    const out = applyFragmentMergeToExtractedItems(items, 2);
    expect(out).toHaveLength(3);
    expect(out[1].description).toBe("Primary, comprenant\nfragment text");
    expect(out[1].total).toBe(3513.6);
    expect(out[2].description).toBe("B");
    // out of range → unchanged
    expect(applyFragmentMergeToExtractedItems(items, 0)).toBe(items);
    expect(applyFragmentMergeToExtractedItems(items, 4)).toBe(items);
  });

  it("applyFragmentMergeToTranslations drops the fragment entry, renumbers, preserves edits, applies cleaned text", () => {
    const lines: DevisTranslationLine[] = [
      { lineNumber: 5, originalDescription: "ligne 5", translation: "line 5", edited: false },
      { lineNumber: 6, originalDescription: "Ps.11-ps.22 préparation bassin…, comprenant", translation: "pool preparation …asasin", edited: true },
      { lineNumber: 7, originalDescription: "Inspection, relevé de cotes…", translation: "", edited: true },
      { lineNumber: 8, originalDescription: "Ps.25 pose de deux skimmers", translation: "installation of two skimmers", edited: false },
    ];
    const merged = applyFragmentMergeToTranslations(
      lines, 7,
      "Ps.11-ps.22 préparation bassin…, comprenant\nInspection, relevé de cotes…",
      "Ps.11-ps.22 pool preparation\ncomplete pool preparation before installation of reinforced PVC, including inspection.",
    );
    expect(merged).toHaveLength(3);
    expect(merged.map((l) => l.lineNumber)).toEqual([5, 6, 7]);
    const primary = merged.find((l) => l.lineNumber === 6)!;
    expect(primary.originalDescription).toContain("Inspection, relevé de cotes");
    expect(primary.translation).not.toContain("asasin");
    expect(primary.edited).toBe(true);
    // Skimmers entry renumbered 8 → 7 with its text untouched.
    const skimmers = merged.find((l) => l.lineNumber === 7)!;
    expect(skimmers.translation).toBe("installation of two skimmers");
    expect(skimmers.edited).toBe(false);
  });

  it("folds a non-empty hand-edited fragment translation into the primary when no cleaned text is given", () => {
    const lines: DevisTranslationLine[] = [
      { lineNumber: 6, originalDescription: "orig 6", translation: "primary translation", edited: false },
      { lineNumber: 7, originalDescription: "frag", translation: "hand-written continuation", edited: true },
      { lineNumber: 8, originalDescription: "next", translation: "next line", edited: false },
    ];
    const merged = applyFragmentMergeToTranslations(lines, 7, "orig 6\nfrag");
    expect(merged).toHaveLength(2);
    const primary = merged.find((l) => l.lineNumber === 6)!;
    expect(primary.translation).toBe("primary translation\nhand-written continuation");
    expect(primary.edited).toBe(true); // fragment was hand-edited
    expect(merged.find((l) => l.lineNumber === 7)!.translation).toBe("next line");
  });

  it("an explicit cleaned translation replaces the fold entirely", () => {
    const lines: DevisTranslationLine[] = [
      { lineNumber: 6, originalDescription: "orig 6", translation: "primary", edited: false },
      { lineNumber: 7, originalDescription: "frag", translation: "hand-written continuation", edited: true },
    ];
    const merged = applyFragmentMergeToTranslations(lines, 7, "orig 6\nfrag", "the clean merged translation");
    expect(merged).toHaveLength(1);
    expect(merged[0].translation).toBe("the clean merged translation");
    expect(merged[0].edited).toBe(true);
  });

  it("keeps the existing translation when no cleaned text is given", () => {
    const lines: DevisTranslationLine[] = [
      { lineNumber: 6, originalDescription: "orig 6", translation: "manual translation", edited: true },
      { lineNumber: 7, originalDescription: "frag", translation: "", edited: true },
    ];
    const merged = applyFragmentMergeToTranslations(lines, 7, "orig 6\nfrag");
    expect(merged).toHaveLength(1);
    expect(merged[0].translation).toBe("manual translation");
    expect(merged[0].originalDescription).toBe("orig 6\nfrag");
  });
});

describe("parseDocument applies the fragment merge end-to-end", () => {
  it("a split AI parse comes back with the fragment folded into its item", async () => {
    const { parseDocument } = await import("../gmail/document-parser");
    const aiParse = {
      documentType: "quotation",
      amountHt: 6627.48,
      amountTtc: 7952.98,
      lineItems: [PRIMARY, FRAGMENT, NEXT],
    };
    const parsed = await parseDocument(Buffer.from("%PDF-1.4 fake"), "devis.pdf", {
      pdfToImagesWithCoverage: vi.fn(async () => ({ images: [Buffer.from("img1"), Buffer.from("img2")], pdfPageCount: 2 })),
      getPageTexts: vi.fn(async () => ["texte page 1", "texte page 2"]),
      getActiveModel: vi.fn(async () => ({ provider: "gemini", modelId: "test-model" })),
      parseWithGemini: vi.fn(async () => JSON.parse(JSON.stringify(aiParse))),
    });
    expect(parsed.lineItems).toHaveLength(2);
    expect(parsed.lineItems![0].description).toContain("Inspection, relevé de cotes");
    expect(parsed.lineItems![0].total).toBe(3513.6);
    expect(parsed.lineItems![1].description).toBe("Ps.25 pose de deux skimmers");
  });
});
