---
name: Acompte in Certified figures
description: How the financial summary counts acompte certificats without double-counting recouped deposits
---

"Certified" per devis = facture sums + OUTSTANDING acompte (issued, non-superseded acompte cert works HT minus contractor-level `cumulativeAcompteRecoupment` read from the LATEST issued non-superseded progress cert — latest-prior rule, never max()/sum()). Devis with `acompteState = 'applied'` contributes 0 (deposit recovered via invoice-deduction path).

**Why:** an acompte cert has no facture; without this a client sees a payment demand next to "Certified 0,00 €". Once fully recouped, certified degrades exactly to the invoice sum — no double count.

**How to apply:** status gate is ready/sent/paid — but the issuance render happens while the row is still `draft` (seal flips status after the PDF commits). Callers rendering a certificat's own PDF must pass `treatAsIssuedCertificatIds: [id]` to `getProjectFinancialSummary`, and that opt-in applies to BOTH the acompte selection AND the progress-cert recoupment source (a draft progress cert being sealed must apply its own recoupment, or its own PDF double-counts the deposit).
