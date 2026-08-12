---
name: Certificat reissue & superseded status
description: How the sealed-certificat reissue flow keeps money and lifecycle consistent.
---

Rule: `superseded` is a terminal, server-set-only certificat status written exclusively by the atomic reissue transaction (draft INSERT + supersede UPDATE in ONE tx, single winner via partial unique index on `reissued_from_certificat_id`). Superseded rows must be excluded from EVERY prior-cumulative consumer: the deduction resolver, the PDF annexe previous-certificat history, and the client live preview — and refused by the send endpoint.

**Why:** a superseded certificat is corrected history; counting it double-counts the replaced payment in later certificats' math and PDFs, and reactivating or re-sending it would put two active payment instructions in the chain.

**How to apply:** any new code that aggregates "prior certificats" for a (project, contractor) must filter `status !== "superseded"`. New statuses must be added to the `certificats_status_check` DB constraint and the route-level `clientSettableStatus` enum together. Note: drizzle/node-postgres can wrap PG errors — unwrap the `cause` chain before branching on SQLSTATE/constraint.
