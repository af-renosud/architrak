# Temporary picomatch risk acceptance

## Current status — advisory withdrawn on 18 November 2026

GitHub withdrew [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
at **15:38:56 UTC on 18 November 2026**. The
[maintainer's explanation](https://github.com/micromatch/picomatch/pull/235#issuecomment-6315749381)
rejects the report as a vulnerability and advises against accepting untrusted
glob patterns. The earlier recheck below predates that withdrawal.

A fresh filesystem walk found both application npm manifest/lockfile pairs
and the two platform skill templates described below. `npm audit fix` was run
independently in both application directories; neither tracked lockfile
changed. The auth template again returned `ENOLOCK`; the Windows template
has no npm dependencies.

**No patched release was installed.** The registry still lists 4.0.7 as the
latest picomatch release, and both application lockfiles still resolve to
4.0.7. This finding is resolved by upstream withdrawal, not by changing or
removing that version. Both fresh npm audits and the project dependency
scanner no longer report this advisory. The root npm audit still reports
five moderate findings representing the unrelated glob/minimatch chain;
the sandbox audit reports zero findings.

Application code does not import picomatch, fdir or tinyglobby, and the
production build's bundle and external-dependency checks confirm their
absence from the server runtime. Replacing Vite/Vitest or using an unverified
fork solely to remove 4.0.7 would add compatibility risk without an upstream
security fix. Keep untrusted glob patterns out of build/test tooling.

Both application type checks, both production builds, and the 16 targeted
dependency-security/audit-policy tests passed after the recheck. The sandbox
build requires its configured `BASE_PATH=/__mockup/`.

The historical exception below has **not** been extended or broadened. It
is not exercised by current audit results; its fail-closed handling remains
in place in case the advisory is reinstated.

## Historical risk acceptance and pre-withdrawal recheck

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

## Upstream recheck — 18 November 2026

The GitHub advisory still lists **all versions through 4.0.7** as vulnerable
and provides no first patched version. The npm registry's latest release is
4.0.7. Running `npm audit fix` independently in the root application and
mockup sandbox updated both lockfiles from picomatch 4.0.4 to 4.0.7 (and Vite
7.3.7 to 7.3.8). These updates **do not fix this advisory**; npm still reports
it in both dependency trees. No resolved picomatch 4.0.4 installation remains
in either lockfile. Transitive `^4.0.4` ranges are not exact pins and resolve
to 4.0.7.

A filesystem walk, pruning dependency, VCS and build-output directories,
also found two platform skill templates: an npm auth template with unresolved
workspace/catalog dependencies and no lockfile, and a Windows .NET project
template. Neither references picomatch. The auth template's `npm audit fix`
cannot run without a lockfile; it is not an independently installable app.
The .NET template has no npm dependency graph or applicable automatic fix.

The production build passed its bundled-input and external-dependency checks:
picomatch and its affected build/test parents are absent from the server
runtime graph. No application code directly imports picomatch, fdir or
tinyglobby. Replacing a glob library alone would not remove Vite/Vitest's
dependency; replacing the build and test toolchains or adopting an unverified
fork would be a broader, higher-risk change, not a verified security update.
The existing exception and its expiry remain unchanged. A verified upstream
patch is still required to close the vulnerability.

Verification passed: both application type checks, both production builds,
and the 16 dependency-security/audit-policy tests. The root audit additionally
reports five moderate findings in the archiver/glob/minimatch dependency
chain, outside this advisory's scope.
