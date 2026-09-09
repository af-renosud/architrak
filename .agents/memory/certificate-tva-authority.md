---
name: Certificate TVA authority
description: Authority, evidence precedence, and refusal rules for payment-certificate TVA.
---

Certificate TVA is server-owned. Public callers provide one cumulative works
amount and choose whether it is HT or TTC; they may not provide a rate,
provenance, autoliquidation flag, TVA amount, counterpart total, or net total.
Preview is non-persisting, and final creation recomputes from locked evidence.
Client preview queries must be project-scoped and immediately stale because
their visible form inputs do not capture every fiscal/payment dependency.
Reopening must refetch, and submission stays disabled while it does.

Evidence precedence is: autoliquidation, exact selected invoice evidence,
signed-quotation HT/TTC evidence, marché configuration, contractor
configuration. If none is trustworthy, refuse with `TVA_EVIDENCE_REQUIRED`;
never invent a standard 20% rate.

Historical and signed-quotation drafts may preserve their recorded decision
internally at seal/reissue/PATCH, but this does not reopen a public override
path. Persist TVA evidence kind independently from certificate source links:
those links may be presentation/payment-claim rows that did not establish TVA.
Configuration-only certificates must pass an explicit empty documentary set,
never trigger a global invoice scan. Exact invoice-backed certificates remain
bound to their persisted source set, and supported invoice mutation paths must
not alter active certificate evidence.

**Why:** TVA changes payment authorization. Accepting browser-derived values,
using a fallback, blending unrelated invoices, or letting source evidence
drift can silently change money between preview, draft, and issuance.

**How to apply:** Any new certificate creation, editing, issuance, deposit, or
invoice-maintenance path must use the same server resolver, preserve
autoliquidation precedence, reject derived client fields explicitly, keep TVA
authority distinct from presentation/source claims, and keep claimed evidence
immutable while an active certificate references it. Never let the global
infinite query freshness apply to manual financial previews.