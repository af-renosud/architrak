---
name: SIRET extraction safeguard
description: Vision-model SIRET misreads and the deterministic text-layer/Luhn cross-check policy
---

Vision models (Gemini/OpenAI on rasterised pages) occasionally hallucinate digits in SIRETs (e.g. 5→2, 6→8) even when the PDF has a perfect embedded text layer — this parked a valid devis as "unknown contractor".

**Rule:** after AI extraction, cross-check the SIRET against the PDF text layer (pdftotext) + Luhn checksum (both the 14-digit SIRET and its 9-digit SIREN prefix must pass).

**Why:** the text layer is deterministic ground truth; a Luhn-invalid 14-digit number cannot be a real SIRET, so it is always a misread.

**How to apply:**
- Override the AI value only when it is missing or checksum-invalid AND exactly one Luhn-valid candidate exists in the text layer.
- NEVER replace a checksum-valid AI read with a text-layer candidate — record an audit note instead (the valid read may come from a scanned header the text layer lacks).
- Candidates must come from MAXIMAL digit runs, or IBAN/phone windows produce false positives.
- Record the decision in extractedData (siretCrossCheck) so it is auditable.
