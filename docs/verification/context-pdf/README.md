# Verification: per-line context boxes in the real DocRaptor translated PDF

Repeatable check: `DEVIS_ID=<id> npx tsx scripts/verify-context-pdf-render.ts`
(requires a devis with line items, an original PDF, and a non-finalised ready
translation row; generates through the real DocRaptor API).

## Result (devis 2, DVP0000386) — all checks pass

Programmatic assertions (see script output):
- both context links (custom label + bare URL) are real clickable `/URI`
  annotations in the PDF (inspected via `qpdf --qdf`; annots live in
  compressed object streams, so raw grep misses them);
- the PDF is self-contained (images inlined as data URIs — DocRaptor never
  fetches external URLs);
- translated PDF cache key published after generation; combined PDF leads
  with the translation pages and its key is cached;
- editing a context clears BOTH cache keys and bumps `contexts_version`.

Visual review (rasterised pages committed alongside this file):
- `translated-page1-context-box.png` — the context cell renders with the
  tinted background + gold left border, label "CONTEXT — LINE 1", bold and
  italic text, a bullet list, an underlined link with its URL printed beside
  it, and the inlined image constrained to 80×60mm.
- `translated-page2-tall-image.png` — a 500×1500px pasted image is height-
  constrained and `break-inside: avoid` keeps it whole; the context box is
  never split mid-image across pages.

## Defect found & fixed during verification

PrinceXML does not support `display: grid`: the header meta block (Project /
Contractor / Devis № / …) rendered as one stacked column. Fixed in
`server/communications/devis-translation-generator.ts` by switching `.meta`
to inline-block cells (4-across), confirmed in the re-generated PDF
(`translated-page1-context-box.png` shows the fixed layout).
