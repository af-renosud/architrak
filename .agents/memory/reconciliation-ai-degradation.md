---
name: Reconciliation AI degradation
description: Why the overlap-detection orchestrator must treat an AI-error verdict differently from an "unrelated" verdict.
---

# Reconciliation AI degradation

In `server/services/reconciliation/overlap-detection.service.ts`
`runProjectReconciliation`, inside the `aiAvailable` branch a `null` from
`classifyRelationship` means a **transient model/parse failure** (the API key
and members are both guaranteed present there) — it does NOT mean "AI disabled"
or "unrelated". Treat it as an error and **degrade to the deterministic
arithmetic verdict** (`aggregates`, proven iff the subset-sum reconciles).

**Why:** an earlier version collapsed `!verdictAi || relationshipType ===
"unrelated"` into a single `continue`, so a Gemini outage silently dropped
arithmetically-strong overlaps AND marked the job succeeded (no retry) — exactly
the double-counting risk the engine exists to catch. Architect flagged this as
blocking.

**How to apply:** keep the three-way split — null → arithmetic fallback (only
when the group has an `arithmetic` source and reconciles); explicit `unrelated`
→ skip as noise; otherwise use the model verdict. The whole engine also degrades
to arithmetic-only when `GEMINI_API_KEY` is absent (the `else` branch). Any
future change to the reasoning return contract must preserve this distinction.
