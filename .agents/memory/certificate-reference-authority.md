---
name: Certificate reference authority
description: Project certificate C-number references are immutable, server-owned identifiers.
---

Certificate references use the project-level `C<number>` sequence and are owned exclusively by the application. Client forms may display a number returned by the server, but must never ask for, submit, override, or patch one. Every certificate-producing and certificate-mutating HTTP boundary must explicitly reject a client-supplied reference, including drafts, reissues, invoice-backed certificates, and deposit certificates.

**Why:** The creator explicitly confirmed this as a hard business rule after a misleading creation dialog asked the operator to enter an example such as C43. A certificate number is an audit identifier, not user-entered metadata.

**How to apply:** Keep allocation server-side and project-scoped, preserve the database uniqueness backstop, treat previews as provisional, and add any new certificate creation route to the shared client-reference rejection boundary.