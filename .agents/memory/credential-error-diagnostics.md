---
name: Credential-bearing errors
description: Why OAuth and database error diagnostics must use a fixed allowlist rather than message redaction.
---

Treat OAuth/API and database exceptions as secret-bearing even when logging only
their message or stack. Database wrappers embed bind parameters in the message;
Google clients embed refresh requests and Authorization headers in nested fields.
Use fixed diagnostic categories and numeric HTTP status codes, never arbitrary
error names/codes, messages, stacks, causes, or serialized request objects.

**Why:** Production verification found refreshed Gmail token persistence errors
exposing sensitive parameter values. Pattern-based token redaction cannot cover
arbitrary SQL parameter values or every OAuth error representation.

**How to apply:** Keep exception details out of logs and persisted poll-status
strings at every catch boundary. Preserve operational classification separately.
Audit callers after a safe-log-and-rethrow: scheduled sends, weekly digests,
operator alerts and invoice-email queues can log the original exception again.
Testing only the immediate Gmail catch does not establish end-to-end log safety.
The app-owned Google inbox grant and the Replit Gmail connector are distinct;
credential recovery must target the affected grant with owner approval, not
silently reconnect or rotate a working integration.