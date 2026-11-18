# Temporary picomatch risk acceptance

Approved on 18 November 2026; expires **2 December 2026 at 00:00 UTC**.

This is a temporary risk acceptance, not a fix or a clean security audit.
It applies only to GHSA-fc5q-39xc-vjpf (CVE-2026-112366), at high severity,
and its known dependency paths through picomatch, fdir, tinyglobby, Vite and
Vitest. New advisories, critical escalation, malformed audit results and
expiry remain blocking. Both tracked npm package trees are audited.

The reported issue is CPU exhaustion from attacker-controlled glob patterns.
Application code does not directly use these packages. The production build
excludes the development Vite loader and checks the bundled server inputs and
external dependency graph for these packages. Build/test tooling still uses
them: do not run builds/tests on untrusted source or accept user-supplied glob
patterns. Production runtime exclusion does not remove development-tool risk.

Before expiry, review the upstream advisory and install a verified fixed
release if available, rerun all checks, then remove the exception. Do not
automatically extend it. A separate platform security policy may still block
publication.
