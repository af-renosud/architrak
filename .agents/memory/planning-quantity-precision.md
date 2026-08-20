---
name: Planning quantity precision
description: Keep Planning quantity validation aligned with the database's three-decimal scale without relaxing money validation.
---

Planning line quantities have their own numeric precision: accept non-negative decimal strings with up to three decimal places. Do not reuse the two-decimal monetary validator for quantities.

**Why:** PDF-imported quantities are persisted and later re-rendered in database form such as `1.000` and `2.000`. A money-shaped validator rejects those legitimate values with a misleading "non-negative" error even though they are positive.

**How to apply:** When changing Planning request validation, UI input steps, import mapping, or line persistence, preserve the `numeric(12,3)` quantity scale. Keep unit prices, totals, tax, and header currency amounts on their stricter two-decimal rules. If an error implies a sign problem, inspect the stored/extracted value before broadening signed-number support.