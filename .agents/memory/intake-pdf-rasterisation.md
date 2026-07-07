---
name: Intake PDF rasterisation robustness
description: Why intake documents park as "unknown" and how the converter must degrade
---

Intake AI classification is vision-based: the PDF is rasterised to PNGs, then the
images go to Gemini. If rasterisation yields ZERO images the doc is classified
`unknown` and parked — so a *conversion* failure masquerades as a *classification*
failure. Supplier PDFs are frequently protected / oddly-linearised / have malformed
xref tables; a single rasteriser (`pdftoppm`, poppler Splash backend) crashes on a
non-trivial fraction of them even after `qpdf --decrypt`.

**Rule:** the rasteriser must be a fallback chain, not one command:
pdftoppm → pdftocairo (poppler Cairo backend) → Ghostscript repair
(`gs -sDEVICE=pdfwrite` then pdftoppm on the rewritten file) → Ghostscript direct
render (`gs -sDEVICE=png16m`). Ghostscript (`gs`) is NOT in the base image — it must
be installed as a nix system dependency (`ghostscript`); pdftocairo ships with
poppler-utils. Determine success by counting produced PNGs, not exit status, and
clear stale PNGs between attempts.

**Why:** `execFile` only surfaces a generic "Command failed"; the real reason lives in
stderr. Capture per-strategy stderr and, when ALL strategies fail, throw an Error with
the collected diagnostics. `parseDocument` catches it into
`rawText: "Parse failed: …"`, which the ingest-queue park path turns into a clear
operator note instead of the misleading "document type unknown".

**How to apply:** any change to `pdfToImages` must preserve the multi-strategy chain
and the throw-with-diagnostics contract; returning `[]` silently would re-hide
conversion failures as bogus `unknown` classifications. Keep the 120s per-strategy cap
(200 DPI multi-page scans need >30s). Regression-tested by mocking `execFile` to make a
chosen strategy the first to emit a PNG.
