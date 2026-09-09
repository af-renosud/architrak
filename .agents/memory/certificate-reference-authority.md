---
name: Certificate reference authority
description: Project certificate C-number references are immutable, server-owned identifiers.
---

Certificate references use the project-level `C<number>` sequence and are owned exclusively by the application. Client forms may display a number returned by the server, but must never ask for, submit, override, or patch one. Every certificate-producing and certificate-mutating HTTP boundary must explicitly reject a client-supplied reference, including drafts, reissues, invoice-backed certificates, and deposit certificates.

**Why:** The creator explicitly confirmed this as a hard business rule after a misleading creation dialog asked the operator to enter an example such as C43. A certificate number is an audit identifier, not user-entered metadata.

**How to apply:** Keep allocation server-side and project-scoped, preserve the database uniqueness backstop, treat previews as provisional, and add any new certificate creation route to the shared client-reference rejection boundary.

Every creation path must allocate through the same project-scoped transaction lock and insert the certificate before that transaction commits. Acquire the project allocator lock before contractor, devis, invoice, certificate, or project-row locks; do not add route-specific retries for reference collisions.

**Why:** Mixed creation paths can deadlock when one transaction holds a business row while waiting for the project allocator and another holds the allocator while its certificate insert needs a foreign-key lock on that row. A collision after serialized allocation is an invariant failure, not a transient condition to hide with retries.

**How to apply:** Start certificate-creation transactions with the shared allocator using a pre-read/trusted project identity, then lock and revalidate flow-specific rows before inserting with the allocated reference. Keep the project/reference unique constraint as the final backstop.