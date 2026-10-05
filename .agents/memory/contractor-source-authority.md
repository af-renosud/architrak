---
name: Contractor quotation source authority
description: Architect controls working content and figures; original PDF and independently recorded TTC remain authoritative.
---
## Current policy — explicitly revised 2026-10-05

The architect may rearrange, replace and create working descriptions, translations and contextual explanations, add contextual or priced lines, and correct actual working figures. The user explicitly requests control of figures, not just text-only or zero-value additions. The completed working quotation must match the independently recorded, locked TTC of the original contractor PDF.

**Why:** Repeated extraction attempts still left legitimate equal-price items with shifted/incomplete descriptions. The user wants prompt architect corrections rather than machine-verification vetoes. The user identifies the original PDF as the contractual document attached to the client link and ultimately signed.

**How to apply:** Provide a batch correction workflow with editable working quantities, prices, VAT and amounts, plus new lines and free content editing. Reconcile the entire correction against source TTC server-side before applying/sharing it; intermediate unsaved edits may temporarily differ. Never update the source baseline from edited rows, silently balance discrepancies, or overwrite the original PDF. Retain automatic actor/time/before-and-after history without burdensome per-text-edit reasons or AI-only permission checks.

This supersedes the former ban on manual description realignment, the prohibition on editing individual working figures, and the conditional-only proposal for full editing. It does not authorize rewriting signed evidence, invoices, certificates or payment history. Distinguish human-reviewed contextual content from machine-verified extraction.

## Source baseline and interpretation

Missing or misread intake totals are not authoritative source figures. Provide a straightforward original-PDF transcription/confirmation path to establish the baseline; preserve its provenance independently of the working quotation.

**Why:** Freezing a placeholder would prevent legitimate correction, while deriving the baseline from edited rows would defeat the TTC backstop.

**How to apply:** Keep source and working data separate. Enforce exact financial arithmetic with actual VAT/discount treatment; TTC equality protects the total but does not certify individual descriptions or VAT correctness. The architect is responsible for reviewing the contextual interpretation.

Two equal-price joinery rows are legitimate separate items; the problem is shifted descriptions and a missing terminal specification. Do not infer duplication from matching prices or repair this case by deleting an item.

**Why:** Equal prices and matching totals cannot establish product identity. The user explicitly confirms both items are valid.

## Implemented control boundary

The expanded quotation exposes an architect working editor with explicit atomic save, stable row IDs,
bilingual content/explanations, contextual and priced additions, reordering and passage transfer.
`quotation_source_baselines` records a one-time human PDF transcription tied to its SHA-256 digest;
`quotation_architect_audit` retains actor/time and full before-and-after data. Neither ordinary saves nor
re-scraping may rewrite that PDF/extraction receipt. Financial saves use shared decimal/cents arithmetic,
actual VAT, accepted options, explicit HT discounts and source-selected VAT rounding. Text-only edits remain
available without a stale OCR manifest. Human Approve is distinct from automatic verification.
Existing signed PDFs, pins, financial references and payment/certificate history remain untouched.
Corrected quotation signing must fail closed if an original-containing combined package is unavailable.