---
name: Supplier portal source accuracy and formatting
description: Accuracy boundaries for PDF locators and preservation of authored question formatting.
---

Do not treat AI-estimated PDF boxes or positional re-extraction joins as verified source locations. Match actual source text and financial/contextual evidence; ambiguity must result in an explicit page-only fallback, not a precise-looking guessed rectangle.

**Why:** The supplier portal highlighted radiator rows for a shower-tray question. A geometrically valid box does not establish that it points to the right item.

**How to apply:** Preserve original PDFs and quotation financial records. Correct locator behavior independently of re-importing quotations. Do not claim exact scanned-PDF localization without coordinate-bearing OCR evidence.

General supplier questions must preserve paragraphs, emphasis and lists through editing, saving, reopening and portal rendering. Keep plain-email summaries readable rather than exposing formatting markup.

**Why:** The user reported that flattened questions are harder to read and may cause mistakes.

**How to apply:** Render only allowlisted formatting, never arbitrary supplied HTML attributes or executable markup. Preserve legacy plain-text newlines.
