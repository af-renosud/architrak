---
name: Intake queue / document state drift
description: Why an intake document can wedge on "analyzing" forever and how recovery must work
---

The intake pipeline tracks state in TWO places that can diverge: the queue row
(`intake_jobs.state`) and the owning document (`project_intake_documents.analysisState`).

**Rule:** every terminal outcome must guarantee the *document* reaches a terminal
state, not just the queue row. The in_flight stale-reclaim only rescues a crashed
worker (job still `in_flight`); it CANNOT rescue a document left on `analyzing`
whose job already went `dead_letter`/`failed`. That split happens when the
"dead-letter the job" write lands but the paired "mark document failed" write does
not (DB blip) — a real production wedge.

**Why:** the permanent/exhausted branch does two sequential writes and the second
(document → failed) is best-effort with a swallowed `.catch`. A flaky DB between the
two leaves a permanently spinning document with no self-heal.

**How to apply:** keep the sweeper's drift-repair pass
(`failOrphanedAnalyzingIntakeDocuments`) — it forces any `analyzing` doc whose job is
terminal to `failed` each tick. If you ever add new terminal paths, do NOT rely on a
single best-effort document write; the repair pass is the backstop. Ideally make the
two writes atomic.

Separately: PDF rasterisation (`pdftoppm`) is the heaviest step and its `execFile`
timeout must stay generous (currently 120s) — a kill there is caught and parked as
`unknown`, but under DB stress it contributed to the wedge.
