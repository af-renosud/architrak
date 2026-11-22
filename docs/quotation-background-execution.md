# Quotation extraction execution

The current published deployment was confirmed as Autoscale. Replit documents
that Autoscale can scale to zero when idle; Reserved VM deployments stay on.
The web-process sweeper therefore runs while an instance is alive and resumes
pending or interrupted jobs at startup. It does not guarantee continuous work
while the deployment sleeps. Closing a quotation does not delete the database
job or completed page groups.

Completed model chunks are stored in the existing extraction-event table,
keyed by source bytes, parser identity, prompts, model/fallback settings,
page grouping and rendered image bytes. They are untrusted model results,
not source-verification receipts. Whole-document reconciliation still runs
before a candidate can be prepared, and applying it remains explicit.

Workers hold a session advisory lock, fence writes by owner token, update a
heartbeat, and impose a ten-minute attempt deadline. Transient failures can
retry at most three attempts with delay. Manual retry retains compatible
chunks; incompatible source/settings use a different key.

For guaranteed unattended execution while nobody uses the app, an always-on
worker/Reserved VM requires a separate hosting decision. No hosting setting
or cost was changed as part of this work.

Reference: https://docs.replit.com/features/publishing/deployment-types
