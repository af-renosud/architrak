# Illustrated quotation extraction investigation

## Observed problem

Read-only inspection of quotation 260309 found an 11-page PDF whose priced
“fourniture et pose” rows are machine-readable, while product specifications
and drawings are embedded images. Some product blocks continue across pages.
The stored extraction processed all pages but contained generic “Composé de”
descriptions. Subsequent source review and user clarification established that
the apparent duplicate was two legitimate equal-price items: descriptions were
shifted, and the terminal MEXT 205 specification was missing.
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

## Reference-led supplier cards

The parser also recognizes two strictly labelled card formats, independent of
“fourniture et pose” / “Composé de”:

- `Repère : WIN-01`, a drawing caption, then
  `Quantité : 1  Prix unitaire HT : 100,00  Total HT : 100,00`.
- `Référence produit : WIN-01`, a drawing caption, then
  `P.U. HT : 100,00  Qté : 1  Montant HT : 100,00`.

These are conservative templates, **not general support for every illustrated
supplier PDF**. At least three unique product references, drawing captions and
complete arithmetic-consistent price rows are required. A `(suite)` reference
must name the current product; the description can span pages but the page hint
remains the price page. Equal-price products must retain their distinct
references in candidate descriptions. Missing, repeated, mixed or unrecognized
monetary rows reject the whole recovery. Blank/unreadable text pages also reject
it: no model-invented source evidence is allowed.
For these reference-led formats, exactly one printed `TOTAL GENERAL HT` must
independently match the source-row sum; missing, conflicting or duplicate totals
are review-only. Integer amounts with HT/currency labels and credit, transport
or fee rows are rejected too, including zero-net adjustments that leave the
overall sum unchanged.
Unknown numeric lines also fail closed regardless of their labels or currency
notation; only the exact drawing-caption dimension shape is exempt. This is
intentionally restrictive for untested specification formats. Total labels are
recognized before parsing their values, so an unreadable duplicate is rejected.

Source options, alternatives and discounts are deliberately review-only, even
if arithmetic happens to reconcile; baseline option/discount descriptions also
prevent replacement. No option is dropped, discount guessed, or exclusion
inferred from a total difference. This pass only replaces fresh parser output,
not stored quotations, corrections, translations or assets. No persistence or
re-scrape endpoint is used by the regression fixtures.

The printed HT must reconcile **before** spending a recovery call. The existing
Gemini-only, 20-page, 15-MiB and 120-second limits still apply; there is one
additional native-PDF request and no recovery retry/layout-map request.
Rejected evidence, unsupported providers, exceeded budgets, failed requests,
rejected candidates and successful recoveries all retain review advisories.
Even a successful recovery does not prove image/specification associations.

### Verification and limits

`server/__tests__/fixtures/illustrated-supplier.ts` builds two disposable
four-page, illustrated PDFs with fictional references/prices, an explicit
continuation and two equal-price products. Regression tests run Poppler on the
actual generated PDF bytes, then check ordered source prices, reference identity,
page provenance, rejection cases and parser call budgets with mocked model
responses. Temporary source files are removed after each test. No private PDF
or extracted private text is included in fixtures.

Local disposable copies of existing ordinary supplier tables were also inspected
as negative controls; those are not evidence for broadening illustrated
eligibility. These tests prove deterministic gating and integration, not live
model accuracy on additional real illustrated suppliers. A new supplier shape
must supply its own independent row evidence before further broadening this gate.

Run:
`npx vitest run server/__tests__/illustrated-quotation.test.ts server/__tests__/illustrated-supplier-layouts.test.ts`

## Independent content verification and guarded review

The illustrated extraction path now inventories positioned supply/install
sections and their cross-page continuations, separately from candidate recovery.
Verbatim coverage checks preserve section identity, numbers and punctuation.
Missing or uncertain evidence blocks confirmation, translation finalisation
and signing. Tesseract independently corroborates graphic references and labelled
dimensions; a generative inventory cannot establish those facts by copying its
own output into a candidate.

Whole-document inventory timed out. Bounded section requests recovered the 18
introductions, including the distinct equal-price products and terminal MEXT 205.
A visual spot-check then caught invented terminal dimensions despite reconciled
prices: matching an inventory to itself is not independent accuracy evidence.
Non-generative graphic corroboration is now required. OCR uncertainty remains
blocking, and neither this check nor a model confidence claim certifies universal
OCR accuracy.

Run focused deterministic checks:
`npx vitest run server/__tests__/quotation-content-coverage.test.ts server/__tests__/quotation-source-manifest.test.ts`

The review panel retains initial OCR differences, independently transcribed
source segments and a complete proposed candidate. Initial-OCR disagreements
require an explicit original-source review and reason. This cannot waive an
uncertain source region or mismatched graphic evidence.

Replacement checks the original PDF digest, bidirectional candidate coverage
and the preparation-time quotation/line/translation fingerprint under locks
before an atomic, append-only audited replacement. Signed/issued or
financially linked evidence, manual translations, context and review edits
prevent destructive replacement. Unedited draft translations are snapshotted
and regenerated. English translation has separate critical-number/reference
and semantic-coverage checks, bound to the exact source and translation version.
This includes the French header, English header description, explanation and
scope summary; header-only edits cannot reuse a line-only verification receipt.
Line-linked internal/client questions block replacement even while the source
line is unchecked. Editing translated content invalidates final approval and
PDF caches atomically; finalisation commits only the exact checked version.
Confirmation rechecks the locked working rows instead of trusting the original
parser flag, including older illustrated extractions lacking a source manifest.

Attempt and review events distinguish unreviewed processing from confirmed
inaccuracies, false alarms, unresolved findings and corrections. Monitoring
counts distinct quotations rather than retries and never changes editing rights.
The annotated attachment is regression evidence only: no live supplier PDF or
quotation has been replaced during implementation.

### Disposable verification outcome

The bounded inventory, with an alternate vision provider for uncertain sections
and independent Tesseract corroboration, passed the reference checks with 18
items and €32,405 HT. MEXT 104 and MEXT 105 remain separate at €1,795 HT;
MEXT 205 remains €915 HT with independently corroborated 600 × 700 mm dimensions.
This is a tested source/candidate result, not a universal OCR accuracy claim or
permission to skip the operator's review of initial-OCR disagreements.

Deterministic tests cover annotated/unannotated synthetic 18-section equivalents,
unchanged-total shifts, omitted specifications and terminal content, rejected
candidate preservation, version conflicts, issued-evidence protection and
explicit approval that cannot waive uncertain source evidence. An authenticated
desktop/mobile browser pass verified persistent reviews, distinct-document
monitoring, preserved inputs on rejected approval and blocked finalisation.