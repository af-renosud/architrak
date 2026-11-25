---
name: Replacement carry-forward by wording
description: Rules for matching replaced-quotation lines when source identity is missing, and coded-lot VAT tables.
---
Replacement lines match first on exact source identity. If that fails, they match on compacted printed wording (case, accents, spacing and punctuation removed), but only when the wording appears exactly once on each side. These wording-only matches carry translation, context and images and are flagged "figures changed". They never transfer working wording.
**Why:** the user decided that the same French wording with different figures should keep translated work. Repeated wording must never auto-match.
**How to apply:** for a supplier table with letter-spaced headings plus a per-line VAT column and a VAT summary, the strict coded-lot reader keeps the AI descriptions and takes only money and VAT from the PDF. A to-the-cent match against the PDF summary counts as checked, so no manual TTC entry is needed.
