# ADR-0001: Restructure ARCHITECTURE.md as a pure system map

- **Status:** Accepted
- **Date:** 2026-08-17
- **Constitution sections amended:** all (editorial restructure; no rule changed)

## Context

ARCHITECTURE.md had drifted from "map of the system + why" into a mix of code
inventories (a 26-row index table, constraint enumerations, a test count that was
stale by an order of magnitude), command walkthroughs duplicated in `replit.md`, and
sections titled by task numbers. Facts copied from code go stale silently; how-to
content living in two files forces double updates.

## Decision

We will keep a strict boundary between the two documents:

- **ARCHITECTURE.md** holds only components, data flows, invariants, and the
  reasoning behind them. No fact that is derivable by reading the current code
  (counts, inventories, env-var catalogs) may appear there — only the governing
  policy plus a pointer to the code that owns the fact.
- **replit.md** is the single home for commands, dev workflow, repo layout, and
  how-to recipes.
- Feature sections are titled by topic, never by task number. Section numbers
  §4.5/§4.7/§4.8 are preserved because code comments and `replit.md` reference them.
- Sections marked **constitutional** change only via an ADR in `docs/decisions/`
  plus an amendment to ARCHITECTURE.md. This folder and template exist to make
  that amendment process real (the Pennylane scope guardrail already demanded it).

No behavioural rule, invariant, or guardrail was changed by the restructure —
every invariant in the previous text is preserved in meaning.

## Consequences

- Agents and new engineers get the system's shape without re-deriving it, and the
  document can no longer be silently wrong about code-owned facts.
- Contributors must resist re-adding inventories; the editing test is: "could a
  grep answer this?" — if yes, it belongs in code, not the constitution.
- Past decisions are not backfilled as ADRs; ADRs start from this one forward.
