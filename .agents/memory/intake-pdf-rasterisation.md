---
name: Intake PDF rasterisation robustness
description: Why intake documents park as "unknown" and how the converter must degrade
---

Intake AI classification is vision-based: the PDF is rasterised to PNGs, then the
images go to the configured vision model. If rasterisation yields ZERO images the doc is classified
`unknown` and parked — so a *conversion* failure masquerades as a *classification*
failure. Supplier PDFs are frequently protected / oddly-linearised / have malformed
xref tables; a single rasteriser (`pdftoppm`, poppler Splash backend) crashes on a
non-trivial fraction of them even after `qpdf --decrypt`.

**Rule:** the rasteriser must be a fallback chain, not one command:
pdftoppm → pdftocairo (poppler Cairo backend) → Ghostscript repair
(`gs -sDEVICE=pdfwrite` then pdftoppm on the rewritten file) → Ghostscript direct
render (`gs -sDEVICE=png16m`). Ghostscript (`gs`) is NOT in the base image — it must
be installed as a nix system dependency (`ghostscript`); pdftocairo ships with
poppler-utils. Success requires BOTH a zero exit status AND all produced PNGs being
*complete* (8-byte signature + IEND trailer); a non-zero exit with complete PNGs on
disk means the tool crashed after writing some pages — discard and try the next
backend. Clear stale PNGs between attempts.
A rasteriser killed at the time cap leaves a TRUNCATED PNG on disk — accepting it
sends garbage to Gemini, which answers a permanent-looking 400 ("Unable to process
input image") and parks the doc. Timed-out output is NEVER accepted — even complete
PNGs may be missing later pages. When a strategy TIMES OUT above the lowest rung,
descend the DPI ladder (200 → 100 → 72). At the lowest practical DPI, give exactly
ONE independent next backend a terminal chance; if it fails by timeout, crash,
corruption, or incomplete coverage, stop rather than cascading through the rest of
the chain. Every subprocess receives the lesser of its 120s cap and the remaining
overall budget; composite repair + re-render steps share that one deadline.
Hard crashes before the lowest-DPI timeout stay at the same DPI and try the next
backend. Vision-model inline-image limits (per-page pixel
dimension + total bytes) are hard: on violation descend DPI, and at the lowest
static rung extend the ladder with a COMPUTED fit DPI (dimensions scale linearly
with DPI, bytes ~quadratically); if compliance is impossible, throw — never send an
oversized payload. An overall wall-clock budget keeps rasterisation inside the
intake sweeper's 10-minute in_flight reclaim window.

**Why:** `execFile` only surfaces a generic "Command failed"; the real reason lives in
stderr. Capture per-strategy stderr and, when ALL strategies fail, throw an Error with
the collected diagnostics. `parseDocument` catches it into
`rawText: "Parse failed: …"`; timeouts/budget exhaustion are marked transient so
the claimed email-document worker schedules bounded retries, while terminal rows
retain a clear operator error instead of the misleading "document type unknown".

**How to apply:** any change to `pdfToImages` must preserve the multi-strategy chain
and the throw-with-diagnostics contract; returning `[]` silently would re-hide
conversion failures as bogus `unknown` classifications. Keep the 120s per-strategy
cap but never let it exceed the remaining overall deadline. Regression-test timeout
sequencing, terminal alternate failure, partial/corrupt output rejection, composite
deadlines, and an independent-backend recovery at the lowest rung.
