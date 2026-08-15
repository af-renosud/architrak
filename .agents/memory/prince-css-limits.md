---
name: PrinceXML CSS limits
description: DocRaptor/PrinceXML rendering quirks observed in real PDF generation
---

- PrinceXML (DocRaptor) does NOT support `display: grid` — grid containers render as stacked block elements. Use tables, floats, or `display: inline-block`/columns for print layout.
- **Why:** Observed in real DocRaptor output: a grid container rendered as a single stacked column while flexbox, table layout, `break-inside: avoid`, and data-URI images all worked fine.
- **How to apply:** When authoring HTML destined for DocRaptor, avoid CSS grid; flexbox works, tables work. Verify layout by rasterising a real generation (`pdftoppm`) rather than a browser preview.
- Link annotations live in compressed object streams — `grep /URI` on the raw PDF finds nothing; run `qpdf --qdf` first.

- Prince supports border/padding on @page itself and repeats it on every physical page (named pages like `@page annexe` do NOT inherit — declare the frame on each).
