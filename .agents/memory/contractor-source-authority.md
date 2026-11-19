---
name: Contractor quotation source authority
description: Architect controls working content and figures; original PDF and independently recorded TTC remain authoritative.
---
## Current policy — explicitly revised 2026-10-05

Human review must be possible without changing an already-correct quotation. Saving a wording correction is not evidence of human approval and must not by itself select a different financial policy.

**Why:** On 2026-11-19 the user requested a coherent repair after repeatedly being sent back to a source-total confirmation already completed. Do not introduce dummy-edit requirements or infer review from the existence of a correction.

**How to apply:** Keep source confirmation, wording/context saves and explicit version-bound approval distinct. Keep financial reconciliation and source integrity safeguards at approval, and never auto-approve existing records as a migration.

Approval regression tests must include a previously architect-corrected quotation, not only an untouched import.

**Why:** The database overwrite guard applies only after an architect correction exists. An unchanged-import approval test passed while corrected quotations failed when approval appended its review receipt.

**How to apply:** Exercise the real database guard during approval and verify that its transaction-scoped permission does not allow subsequent background writes. Keep version and financial checks ahead of that permission.

The architect may rearrange, replace and create working descriptions, translations and contextual explanations, add contextual or priced lines, and correct actual working figures. The user explicitly requests control of figures, not just text-only or zero-value additions. The completed working quotation must match the independently recorded, locked TTC of the original contractor PDF.

**Why:** Repeated extraction attempts still left legitimate equal-price items with shifted/incomplete descriptions. The user wants prompt architect corrections rather than machine-verification vetoes. The user identifies the original PDF as the contractual document attached to the client link and ultimately signed.

**How to apply:** Provide a batch correction workflow with editable working quantities, prices, VAT and amounts, plus new lines and free content editing. Reconcile the entire correction against source TTC server-side before applying/sharing it; intermediate unsaved edits may temporarily differ. Never update the source baseline from edited rows, silently balance discrepancies, or overwrite the original PDF. Retain automatic actor/time/before-and-after history without burdensome per-text-edit reasons or AI-only permission checks.

This supersedes the former ban on manual description realignment, the prohibition on editing individual working figures, and the conditional-only proposal for full editing. It does not authorize rewriting signed evidence, invoices, certificates or payment history. Distinguish human-reviewed contextual content from machine-verified extraction.

## Unsupported extracted items

Removal of an item absent from the PDF is an extraction correction, not a commercial scope change or an unaccepted option.

**Why:** An invented priced item cannot supply a truthful verbatim source excerpt. Merely excluding its price would leave invented content in client-facing descriptions.

**How to apply:** Require explicit human review of the whole original PDF, a reason and a separate financial-impact confirmation; bind the audit to source bytes and preserve linked human/financial evidence rather than silently deleting it.

## Source baseline and interpretation

Missing line VAT on an already corrected quotation should be recovered as a reviewable financial draft, never by re-scraping or replacing the user's descriptions and context.

**Why:** A mixed-rate quotation can have correct header totals but blank per-row VAT; generic decimal errors then trap the operator despite successful text corrections.

**How to apply:** Offer all missing fields together. Source-backed recovery must uniquely match item identity and amount, preserve explicit operator rates, verify source bytes and reconcile independent totals before suggesting rates. Saving remains an audited, version-checked action.

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