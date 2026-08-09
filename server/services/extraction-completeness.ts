// Task #350 — Extraction completeness verification.
//
// Deterministic back-checks that catch silent partial extractions (prod
// DVT0000959: a 7-page devis lost items 24–30 on page 6 because only the
// first 5 pages were ever rendered). Pure functions — no I/O — so they are
// unit-testable and safe to call from any extraction pipeline.

import type { ValidationWarning } from "./extraction-validator";
import type { ExtractionCoverage } from "../gmail/document-parser";

// A page's text layer "evidences" quotation line items when it contains at
// least this many candidate item rows. 3 keeps headers/footers/totals blocks
// from counting as evidence on their own.
export const MIN_CANDIDATE_ROWS_FOR_EVIDENCE = 3;

// Matches a euro amount like "1 234,56", "1.234,56 €", "1234.56".
const EURO_AMOUNT = /\d{1,3}(?:[ \u00A0.]\d{3})*(?:[.,]\d{2})(?:\s*€)?/;
// Common French devis units appearing in item rows.
const UNIT_TOKEN = /\b(?:u|U|ens|ENS|m2|m²|m3|m³|ml|mL|ML|h|H|kg|forfait|fft|FFT|pce|PCE|unité|jour|j)\b/;

/**
 * Counts lines in a page's text layer that look like quotation item rows.
 * Deterministic heuristic, tuned to be conservative:
 *  - a line with TWO OR MORE euro-formatted amounts (unit price + total), or
 *  - a line with one euro amount AND a quantity+unit token, or
 *  - a line starting with an item number ("24.", "24)", "3.2 ") followed by
 *    text AND containing a euro amount.
 * Total/summary lines (TOTAL, TVA, HT, TTC, acompte, retenue…) are excluded.
 */
export function countItemRowCandidates(pageText: string): number {
  let count = 0;
  for (const raw of pageText.split("\n")) {
    const line = raw.trim();
    if (line.length < 8) continue;
    // Exclude totals/summary rows — they carry amounts but are not items.
    if (/^(sous[- ]?total|total|montant|tva|t\.v\.a|ht\b|ttc\b|net à payer|net a payer|acompte|retenue|remise|arrhes|base)/i.test(line)) {
      continue;
    }
    const amounts = line.match(new RegExp(EURO_AMOUNT.source, "g")) ?? [];
    const startsNumbered = /^\d{1,3}(?:\.\d{1,2})*[).\s-]\s*\S/.test(line);
    const hasUnit = UNIT_TOKEN.test(line);
    if (
      amounts.length >= 2 ||
      (amounts.length >= 1 && hasUnit) ||
      (amounts.length >= 1 && startsNumbered)
    ) {
      count++;
    }
  }
  return count;
}

// ── Task #356 — continuation-paragraph fragment handling ────────────────────
//
// Seen on prod DVP0000661: the AI split the PDF's item 6 in two — the
// description's continuation paragraph ("Inspection, relevé de cotes…")
// became a standalone line with no price, shifting every later line number
// and desynchronising the translation tab.

/** Matches a description that starts with its own item/lot reference:
 *  "GO.05 …", "Ps.11-ps.22 …", "DM.04 …", "1. …", "24) …", "3.2 …". A line
 *  carrying such a reference is a real item even when zero-priced. */
export const LEADING_ITEM_REF = /^(?:[A-Za-z]{1,4}\.\s?\d|\d{1,3}(?:\.\d{1,2})*\s*[).\-]\s)/;

// A previous description that ends "open" — with a colon/semicolon or a
// French connector announcing an enumeration — invites a continuation. A
// trailing comma alone is deliberately NOT enough: too many legitimate
// descriptions end with one, and the automatic merge is irreversible.
const OPEN_ENDING = /(?:[;:]|\b(?:comprenant|incluant|dont|y compris|notamment|suivant(?:es?)?|ci-dessous|à savoir|soit)\s*)$/i;

type LineItem = NonNullable<
  import("../gmail/document-parser").ParsedDocument["lineItems"]
>[number];

function hasOwnAmounts(li: LineItem): boolean {
  const total = li.total;
  const unitPrice = li.unitPrice;
  return (total != null && total !== 0) || (unitPrice != null && unitPrice !== 0);
}

/** True when this extracted line looks like the continuation paragraph of the
 *  previous line's description rather than a real quotation item.
 *
 *  Deliberately conservative — the automatic fold is irreversible, so only
 *  rows with NO amounts at all (an explicit printed 0,00 € — "offert",
 *  "inclus" — is evidence of a real row and stays advisory-only) and no item
 *  reference, following a predecessor that ends mid-enumeration, qualify. */
export function isContinuationFragment(item: LineItem, previous: LineItem | undefined): boolean {
  if (!previous) return false;
  // Any explicit amount — including an explicit zero — means "real row".
  if (item.total != null || item.unitPrice != null) return false;
  const desc = (item.description ?? "").trim();
  if (desc.length === 0) return true; // empty rows always fold away
  if (LEADING_ITEM_REF.test(desc)) return false;
  const prevDesc = (previous.description ?? "").trim();
  return OPEN_ENDING.test(prevDesc);
}

export interface FragmentMergeResult {
  lineItems: LineItem[];
  /** 0-based indices (in the ORIGINAL array) that were merged away. */
  mergedIndices: number[];
}

/**
 * Deterministic post-extraction pass: folds continuation-paragraph fragments
 * back into their predecessor's description. The predecessor keeps its own
 * amounts, pageHint and bbox — a fragment is descriptive text, not a priced
 * row, so its best-effort geometry would mislead the highlight viewer.
 * Chains fold into the same primary line (fragment-of-fragment).
 */
export function mergeContinuationFragments(lineItems: LineItem[]): FragmentMergeResult {
  const out: LineItem[] = [];
  const mergedIndices: number[] = [];
  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    const prev = out[out.length - 1];
    if (isContinuationFragment(item, prev)) {
      const fragText = (item.description ?? "").trim();
      out[out.length - 1] = {
        ...prev,
        description: fragText.length > 0 ? `${prev.description ?? ""}\n${fragText}`.trim() : prev.description,
      };
      mergedIndices.push(i);
    } else {
      out.push({ ...item });
    }
  }
  return { lineItems: out, mergedIndices };
}

/**
 * Advisory for zero-priced, reference-less lines that survived the merge pass
 * (previous line did not end "open", so the deterministic fold refused to
 * guess). These are likely fragments and must surface for operator review.
 */
export function checkFragmentLines(
  lineItems: Array<{ description?: string; total?: number | null; unitPrice?: number | null }>,
): ValidationWarning[] {
  const suspects: number[] = [];
  lineItems.forEach((li, idx) => {
    if (idx === 0) return; // first line has no predecessor to belong to
    const desc = (li.description ?? "").trim();
    if (desc.length === 0) return;
    if (LEADING_ITEM_REF.test(desc)) return;
    if (hasOwnAmounts(li as LineItem)) return;
    suspects.push(idx + 1);
  });
  if (suspects.length === 0) return [];
  return [
    {
      field: "lineFragment",
      expected: 0,
      actual: suspects.length,
      message: `Line${suspects.length > 1 ? "s" : ""} ${suspects.join(", ")} ha${suspects.length > 1 ? "ve" : "s"} no price and no item reference — likely a continuation of the previous line's description that was extracted as a separate item. Verify the numbering against the PDF before confirming.`,
      severity: "warning",
    },
  ];
}

export interface CompletenessInput {
  coverage: ExtractionCoverage | undefined;
  lineItems: Array<{ description?: string; pageHint?: number | null }>;
}

/**
 * Deterministic completeness checks. Returns ValidationWarnings using stable
 * fields so `deriveAdvisoryCode` maps them to stable advisory codes:
 *  - field "pageCoverage"  (error)   — rendered pages < authoritative count.
 *  - field "pageLineItems" (error/warning) — a page whose text layer clearly
 *    evidences item rows produced zero extracted lines. Error only when page
 *    hints are being emitted elsewhere on the document (otherwise the absence
 *    of a hint on that page proves nothing) — degraded to warning when hints
 *    are unavailable or no lines were extracted at all. Pages without a text
 *    layer (scans) never trigger it.
 *  - field "lineNumbering" (warning) — gaps in an otherwise increasing
 *    leading item-number sequence.
 */
export function checkExtractionCompleteness(input: CompletenessInput): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const { coverage, lineItems } = input;
  if (!coverage) return warnings;

  const { pdfPageCount, renderedPageCount, pageEvidence } = coverage;

  if (pdfPageCount != null && renderedPageCount < pdfPageCount) {
    warnings.push({
      field: "pageCoverage",
      expected: pdfPageCount,
      actual: renderedPageCount,
      message: `Only ${renderedPageCount} of ${pdfPageCount} PDF pages were rendered for extraction — content on the missing pages was never shown to the AI. The extraction must be re-run; do not confirm this draft.`,
      severity: "error",
    });
  }

  const hints = lineItems
    .map((li) => li.pageHint)
    .filter((h): h is number => typeof h === "number" && Number.isFinite(h) && h >= 1);
  const hintedPages = new Set(hints);
  const hintsAvailable = hints.length > 0;

  if (pageEvidence && pageEvidence.length > 0) {
    const suspectPages = pageEvidence
      .filter(
        (p) =>
          p.hasTextLayer &&
          p.candidateRows >= MIN_CANDIDATE_ROWS_FOR_EVIDENCE &&
          !hintedPages.has(p.page),
      )
      .map((p) => p.page);

    if (suspectPages.length > 0) {
      // Blocking only when the extractor demonstrably emits page hints on
      // this document AND extracted at least some lines — then a hint-less
      // evidenced page is a real hole. Otherwise (no hints anywhere, or no
      // line items at all, e.g. mode_a documents) it is advisory only.
      const blocking = hintsAvailable && lineItems.length > 0;
      warnings.push({
        field: "pageLineItems",
        expected: 0,
        actual: suspectPages.length,
        message: `Page${suspectPages.length > 1 ? "s" : ""} ${suspectPages.join(", ")} of the PDF text layer contain${suspectPages.length > 1 ? "" : "s"} item-row evidence but no extracted line item points there — line items may be missing from the extraction.${blocking ? " Re-run the extraction before confirming." : ""}`,
        severity: blocking ? "error" : "warning",
      });
    }
  }

  // Numbering continuity: if line descriptions carry leading item numbers
  // forming a mostly-increasing sequence, gaps flag likely missing lines.
  const numbers: number[] = [];
  for (const li of lineItems) {
    const m = (li.description ?? "").trim().match(/^(\d{1,3})[).\s-]/);
    if (m) numbers.push(Number(m[1]));
  }
  if (numbers.length >= 5) {
    const increasing = numbers.every((n, i) => i === 0 || n >= numbers[i - 1]);
    if (increasing) {
      const missing: number[] = [];
      for (let i = 1; i < numbers.length; i++) {
        for (let n = numbers[i - 1] + 1; n < numbers[i]; n++) missing.push(n);
      }
      if (missing.length > 0) {
        warnings.push({
          field: "lineNumbering",
          expected: numbers.length + missing.length,
          actual: numbers.length,
          message: `Line item numbering has gap${missing.length > 1 ? "s" : ""} (missing ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}) — verify no lines were dropped during extraction.`,
          severity: "warning",
        });
      }
    }
  }

  return warnings;
}

/** Fields whose severity "error" must BLOCK persistence of a draft. */
export const BLOCKING_COMPLETENESS_FIELDS = new Set(["pageCoverage", "pageLineItems"]);

export function findBlockingCompletenessWarnings(warnings: ValidationWarning[]): ValidationWarning[] {
  return warnings.filter((w) => w.severity === "error" && BLOCKING_COMPLETENESS_FIELDS.has(w.field));
}
