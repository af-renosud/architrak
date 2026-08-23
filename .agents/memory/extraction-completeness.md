---
name: Extraction completeness verification
description: Rules for keeping PDF extraction complete — full-page rendering, chunked AI requests, deterministic completeness gates.
---

Rule: PDF extraction must render EVERY page and back-check the rendered count against pdfinfo's authoritative page count; a mismatch is a hard failure, never a silently partial draft. Long PDFs are split into ≤5-page AI requests whose pageHints are rebased by chunk offset; identity fields merge first-wins, totals last-wins.

**Why:** a prod 7-page devis lost all of page 6's line items to a 5-page rasterisation prefix cap, and the derived-totals path then made the line-sum check pass trivially (circular). Aggregate-payload image limits also matter: Gemini's byte budget applies per request, so judge the largest chunk window, not the whole document — otherwise long PDFs get needlessly downsampled or fail.

**How to apply:** any change to rasterisation, chunking, or the completeness validator must preserve: (1) pdfinfo back-check with per-strategy discard of incomplete output; (2) numeric (not lexical) PNG page sort — ghostscript's page-%d pattern breaks lexical sort past page 9; (3) blocking severity only when page hints are demonstrably emitted and lines exist (scans/mode_a degrade to warnings); (4) derived totals never satisfy or suppress completeness checks; (5) batch admin re-extraction must enforce draft-only status server-side (rescrape itself only refuses invoices/situations).

For quotation totals-box recovery, the header-total difference is only a search signal: recover a line only when the rendered PDF explicitly shows its description, HT amount, and inclusion in the printed total. Preserve that evidence with the draft, treat same-cent repeats as ambiguous rather than double-counting them, and leave every failed, partial, or ambiguous recovery verification-required.

**Why:** arithmetic can reconcile an incomplete extraction without proving what the omitted option was; a conservative, auditable draft is safer than a false automatic reconciliation.

Rule: When vision silently under-extracts a dense machine-readable quotation, a deterministic text-layer fallback may replace the vision rows only if it parses a strict, complete table shape and its row count exactly matches the independent candidate-row count. Text-derived exclusions must come from explicit option labels, contiguous indexed rows, exact subtotal sums, and an all-or-nothing reconciliation; never derive them from the HT difference.

**Why:** dense vision requests can return valid but incomplete JSON, and different providers may disagree on row grouping or monetary columns. Exact text rows are safer only when independent completeness evidence proves the parser neither dropped nor added rows.

**How to apply:** keep vision authoritative for document identity, visual layout, retained-selection wording, and totals-box evidence. Use the text layer only for exact body-table transcription under the count gate; reject partial parses, summary-row duplication, non-contiguous option groups, and any exclusion set that does not reconcile the printed HT exactly.
