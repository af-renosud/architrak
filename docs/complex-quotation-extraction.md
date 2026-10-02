# Illustrated quotation extraction investigation

## Observed problem

Read-only inspection of quotation 260309 found an 11-page PDF whose priced
“fourniture et pose” rows are machine-readable, while product specifications
and drawings are embedded images. Some product blocks continue across pages.
The stored extraction processed all pages but contained generic “Composé de”
descriptions and duplicated a product at a five-page chunk boundary.
Page coverage alone therefore did not establish item or description completeness.
The historical model is not recorded in that extraction.

## Bounded comparison

Using the same original PDF and Gemini 2.5 Flash, without uploading a new
quotation or calling the destructive re-scrape endpoint:

| Approach | Rows | Sum of line HT | Elapsed |
|---|---:|---:|---:|
| Current rendered-page/chunk pipeline | 10 | 23,640 | 118 seconds |
| Whole native PDF | 18 | 32,405 | 94 seconds |
| Layout map, then extraction | 18 | 31,460 | 182 seconds |

These are single-run observations, not guarantees or a model benchmark.
The printed HT is 32,405. The native result retained product references and
specifications; its 18 quantities, unit prices and totals matched the ordered
source price rows exactly. Some native page hints referred to the specification
page instead of the price page. The layout-first variant misassociated prices
and was rejected.

Native usage was 26,961 total tokens; the two layout calls used 65,893 total
tokens combined (including provider-reported thinking tokens). The baseline
does not expose usage. Monetary cost was not estimated because the effective
account billing rate was not verified. Recovery adds a model call, rather than
replacing baseline parsing.

## Implemented scope and safeguards

The shared parser recognizes a narrow illustrated supply/install block format
from repeated introducing price rows and “Composé de” placeholders. It attempts
whole-PDF recovery only with Gemini, at most 20 pages and 15 MiB, with a bounded
request timeout. Ordinary tables are unchanged.

Every recovered row must match the independent, ordered text-layer quantity,
unit price and HT total. Row counts must agree, the source rows must reconcile
the original printed HT, and the candidate HT must match. Header finances,
VAT, payment terms and identity are never replaced. Page hints come from the
source price rows; potentially wrong image bounding boxes are discarded.

Options, discounts or other layouts that do not meet this strict evidence gate
are not forced to reconcile. Existing validation and completeness checks remain.
Failed, unsupported and successful recovery all retain an operator advisory:
financial agreement cannot establish correct specification/image association.
Repeated equal-price products still need human association review.

The native PDF is read for extraction only. This does not import illustrations
as editable context-image assets or automatically approve translations. No
live quotation, manual correction, context asset or translation was changed.

## Reproduction

`scripts/compare-complex-extraction.ts` accepts a local PDF and a `/tmp/` output
prefix, with optional `baseline`, `native` or `layout` mode. Results contain
private source data and must not be committed. Regression tests use synthetic
data; real PDF/results remain outside the repository.