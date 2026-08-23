---
name: Planning PDF re-scrape identity
description: Rules for auditable and concurrency-safe Planning Envelope PDF re-extraction.
---

Planning PDF re-scrapes are identified by the immutable source revision, that source's version, and the parser version. Concurrent or repeated requests with the same identity must resolve to one draft; a changed parser version may produce a new draft.

**Why:** Operators need to rerun corrected extraction logic without mutating the prior record, while retries and double-clicks must not create duplicate drafts. Parser identity is what distinguishes a genuine new extraction implementation from a replay.

**How to apply:** Whenever Planning PDF extraction, validation, or totals-box recovery behavior changes materially, bump the persisted parser version in lockstep. Keep source eligibility and version checks inside the locked transaction, and never mark the original revision superseded until the replacement is reviewed and approved.