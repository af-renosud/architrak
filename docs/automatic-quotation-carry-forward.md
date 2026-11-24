# Automatic quotation replacement carry-forward

Once an architect designates the old and new quotation, the replacement operation automatically retains uniquely unchanged source items' authored wording, translations, explanations, rich context and independently copied images. The operator does not select those items or approve their copying separately.

## Source matching and protection

- Compare contractor-source content, quantities, units, unit prices and line totals.
- Ignore whitespace, case, typographic apostrophes and equivalent Unicode unit typography. Only headings proved by the strict native-table reader may be omitted during comparison.
- Duplicate matches, missing figures, changed specifications, and existing replacement content remain protected. No fuzzy or AI match authorises a transfer.
- Original extraction evidence is not overwritten. Prior working wording is bound back through immutable audit history or unique source coordinates and figures.
- Financial amendments, signatures, approvals, payment records and source receipts are not copied from the previous quotation.
- Audited wording transfers are bound to the replacement PDF and exact target row/figures so retained wording does not itself invalidate an otherwise valid extraction receipt. Subsequent changes still fail normal checks.
- Removed/unassigned work remains accessible on the earlier quotation.

## Operator steps

1. Use **Replace quotation** on the earlier quotation and select the revised quotation.
2. If its extraction is prepared but not applied, choose **Approve prepared extraction and replace together**. Review the candidate and original PDF, then confirm. Applying the recovered figures and recording the replacement are one transaction: either both succeed or neither changes. No further re-scrape is needed for an eligible prepared candidate.
3. The retention view reports automatic matches. Only changed, ambiguous or conflicting items need manual decisions. Setup, document overview and supporting PDFs remain optional explicit choices.
4. Confirm the replacement. The old quotation becomes historical; the new one keeps its own figures.

Later recovery remains available in **Review previous work**. It is explicit recovery, not a second automatic replacement.

## Existing legacy quotations

Edited rows whose earlier source identity cannot be established are not automatically mapped by price or position alone. This is particularly relevant to older records that predate detailed correction history. Automatic retention is not a promise that every old row can be safely mapped.

Standalone extraction review remains available. The combined replacement path uses its same source, stale-version and financial-protection checks; it cannot overwrite an edited replacement. Publishing does not silently apply prepared production candidates or mutate live quotation records.

Newly created working rows retain an immutable initial-row snapshot tied to their original PDF. Later edits can therefore be matched against the initial source rather than losing that identity. Legacy rows without such evidence still require explicit assignment.

## Verification

Regression tests cover exact/duplicate/changed/unknown matching, source-bound wording, copied image ownership, protected target content, rollback, stale versions and automatic transfers without client selections. A development browser journey verified replacement, retained content after reload, added/removed rows, retained source history and unchanged amounts.
