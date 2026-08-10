---
name: Client portal outbound gating
description: What rich quotation content may reach the client portal, and how the retired verdict endpoints are handled.
---

Rule: the client portal is an outbound surface — rich content is gated exactly like outbound PDFs. English translations, contextual notes, and the complete-package download appear only when the devis translation is FINALISED; the cost analysis additionally requires status=confirmed AND a matching quotationFingerprint (stale → silently omitted).

**Why:** draft/edited translations and unconfirmed/stale analyses are internal review state; showing them to clients would leak unreviewed or wrong figures.

**How to apply:** any new client-portal (or other outbound) surface must reuse these gates, not re-derive looser ones. Context/analysis HTML is always pre-rendered server-side by the whitelisting serializers — never ship raw stored documents to the browser.

The confirmed+fingerprint-fresh analysis gate is centralized in the single document loader shared by the portal payload and the PDF generators — never re-implement it per surface, or paths diverge (a rejected review caught exactly that). Quotation line-item mutations must invalidate the translated/combined PDF cache (they change the fingerprint), same as context saves.

Verdict retirement: the portal's client approve/decline endpoints answer 410 Gone (routes kept occupied so nothing can squat and mint marker rows). Verdict markers and the sanitiser are retained so historical verdict rows render as audit badges and free text can never spoof a verdict; client agreed/rejected sign-off stages remain reachable only via the architect's manual sign-off flow.
