---
name: Prod-side one-shot actions via data migrations
description: How to trigger a production-side data action (e.g. re-queue a wedged document) when you cannot press Publish or operate the prod UI.
---

**Rule:** When a task requires a one-time action against production data (re-queue a parked/wedged record, one-shot backfill), ship it as a hand-tracked data-only SQL migration. Migrations run at every production boot before any sweeper starts, so the action fires exactly once on the first boot after the user publishes — no operator click, no prod-DB write access needed.

**Why:** Task agents cannot press Publish (`suggestDeploy` is main-agent-only) and cannot authenticate to the production UI (domain-restricted Google OAuth); the prod DB replica is read-only. The migration tracker is the only one-shot, deploy-coupled hook available.

**How to apply:**
- Guard the UPDATE tightly (exact id + state + error-note signature) so it is a no-op in dev, replay DBs, and if the record has already moved on. Use a CTE so dependent queue-row resets only fire when the primary guard matched.
- `data_only` migrations are an established pattern here — add the journal entry AND a `kind: "data_only"` row in the schema-presence-check artifact list.
- Verify with the replay gate + dev migration run; dev/prod share the object-storage bucket, so the actual production file can be pulled and run through the fixed code path locally as proof.
- To prove a data-only migration's SQL against the REAL prod rows without touching prod: `\copy` the affected rows from the prod replica to TSV, then in a dev-psql transaction create `scratch.<table> (LIKE public.<table> INCLUDING DEFAULTS)` shadow tables (no FKs), `SET LOCAL search_path = scratch`, load the TSVs, `\i` the migration body (breakpoints stripped), run verification SELECTs, ROLLBACK.
- If you edit a migration's SQL after dev already applied it, delete its dev tracker row (`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = <journal when>`) and reboot so dev re-applies the final content — otherwise dev's tracker hash diverges from the file.
- Production build age can be dated precisely by cross-referencing deployment-log boot timestamps against fix commit times — don't guess whether a fix is live.
