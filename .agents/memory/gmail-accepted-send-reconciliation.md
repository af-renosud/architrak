---
name: Gmail accepted-send reconciliation
description: Duplicate-safe recovery when Gmail accepts an email but persisting its sent state fails.
---

Retryable emails containing bearer links must use an RFC Message-ID derived only from immutable persisted communication identity. Once Gmail accepts such a message, a failed database success write leaves the communication in an in-flight/uncertain state; recovery searches the recorded sender mailbox's Sent folder and marks the existing message sent instead of transmitting again.

**Why:** An atomic database claim prevents concurrent sends but cannot make Gmail delivery and the later database update atomic. Marking a provider-accepted message failed makes an ordinary retry send a duplicate, while including deployment configuration in the Message-ID breaks reconciliation after a restart or URL change.

**How to apply:** For new retryable outbound flows, persist the selected mailbox before provider dispatch, use a stable provider-visible message identity, distinguish pre-provider failures from post-provider uncertainty, and reconcile the same mailbox before permitting another send.