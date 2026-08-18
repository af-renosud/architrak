---
name: Design-contract fee mirrors
description: How to identify legacy fee rows that mirror the design contract, and HT-figure rules
---
The contract-confirm path reconciles at most ONE fee row per component type (conception/planning), writing the contract's component HT amount into it. There is no persisted contract↔fee link.

**Rule:** a fee row is "covered by the design contract" only when the contract carries that component amount AND the row's feeAmountHt equals it, at most one row per type (lowest id). Never treat every conception/planning fee as a mirror — manual fees of the same type are real money and must keep badges + count in totals.

**Rule:** HT figures for contract money come only from contract-supplied data (documentary HT or stated TVA rate). If neither exists, HT is unknown — show TTC with an explicit "HT unavailable" note, never a hard-coded 20% fallback.

**How to apply:** any surface that unifies fees with design-contract milestones (Honoraires page, tiles, exports).
