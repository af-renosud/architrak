---
name: Gmail tiered intake invariants
description: Evidence-tiered email intake — durable invariants for parked statuses, retention, poll paging, and targeted Gmail queries.
---

# Gmail tiered intake invariants

- Only high-evidence mail may enter the AI-processed queue; every other tier parks in a visible, force-rescuable status. The background sweeper must drain ONLY the AI-eligible status — adding any new parked status requires re-checking sweeper drain, claim exclusions, retention scope, and UI default-view filters.
- Archived/closed-project evidence never grants processing eligibility, and archived-candidate mail never auto-expires: a late invoice for a closed project must stay visible until a human acts.
- Low-value parked mail expires by STATUS FLIP to the terminal skipped state with a prepended French audit note — never by deletion.
- Targeted Gmail search strings must be budgeted by serialized characters, not item count (client/project names are unconstrained text); generic construction keywords must never be used as Gmail selectors; always append the broad backstop query.
- Poll durability requires BOTH: (a) a persistent processed-message record written only after the message's disposition is durable, and (b) paging past fully-processed result pages — otherwise a label-permission failure re-fetches the same first page forever and starves older mail.
- A declared PDF attachment whose payload fetch returns empty must FAIL the whole message (so it retries next poll); skipping it after recording the message processed suppresses the document forever.

**Why:** keyword-only junk was burning AI tokens, and a label-permission failure once wedged the poll on the same first page of results indefinitely.
**How to apply:** whenever touching email intake statuses, polling, or retention.

## Durable backfill cursor (no-starvation guarantee)
Processed-prefix paging alone starves backlog deeper than pages*pageSize. Cursor = min(message_date) of processed rows, EXCLUDING pre-watermark rows (or the cursor collapses below the cutoff and disables backfill). Gmail search is second-granular vs ms internalDate, so backfill is two queries: a boundary-BUCKET query bracketing the cursor second, paged until exhausted (high page cap — bounded by one second of mail), plus a DEEP query `before:<cursorSec>` whose page one is prefix-free by definition of the minimum. Deep query is clamped `after:<intake cutoff>`.
