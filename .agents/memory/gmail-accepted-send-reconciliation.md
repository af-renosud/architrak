---
name: Gmail accepted-send reconciliation
description: Duplicate-safe recovery when Gmail accepts an email but persisting its sent state fails.
---

Retryable emails containing bearer links must use a provider-searchable identity derived from immutable persisted communication identity. Once Gmail accepts such a message, a failed database success write leaves the communication in an in-flight/uncertain state; recovery searches the recorded sender mailbox's Sent folder and marks the existing message sent instead of transmitting again.

Live verification showed that Gmail's raw-message send API can replace a caller-supplied RFC Message-ID. Gmail then cannot find the accepted send via `rfc822msgid`, even though the message is present in Sent and Inbox. Gmail did index the unique client-portal token in the sent body and returned exactly one match.

**Why:** An atomic database claim prevents concurrent sends but cannot make Gmail delivery and the later database update atomic. Marking a provider-accepted message failed makes an ordinary retry send a duplicate. Trusting only a caller-supplied Message-ID also fails against real Gmail when Google rewrites it.

**How to apply:** Persist the selected mailbox before provider dispatch, distinguish pre-provider failures from post-provider uncertainty, and reconcile the same mailbox before permitting another send. Keep `rfc822msgid` as a first lookup, but provide a unique body-indexed fallback that remains available when access links are protected at rest.