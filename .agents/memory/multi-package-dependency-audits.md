---
name: Multi-package dependency audits
description: Scope dependency remediation across independently installed artifacts, not just the root application.
---

Audit every independently installed package tree when fixing project-wide dependency findings.

Temporary security exceptions must identify the exact advisory and known dependency chains, expire automatically, and remain visibly labelled as accepted risk—not a fixed vulnerability.

**Why:** The user approved a narrowly scoped, time-limited exception for build/test-only exposure rather than disabling all high-severity checks. A package-name-wide exemption could silently admit unrelated future vulnerabilities.

**How to apply:** Preserve fail-closed handling of new advisories, critical escalation and invalid reports; verify production runtime exclusion and review the documented exception before its expiry.

**Why:** The project dependency scanner includes artifact lockfiles. A clean root npm audit can coexist with vulnerable versions in the mockup sandbox.

**How to apply:** Enumerate manifests and lockfiles with a filesystem walk that prunes dependency/VCS/build directories, including untracked files; inspect all nested occurrences and run scoped audits/build checks for each package tree. Report unrelated remaining findings separately rather than claiming the whole project is vulnerability-free.

The package installation callback rejects an empty package list and directory-selection flags such as `--prefix`.

**Why:** These inputs are validated as package names, so they cannot reinstall a separately installed artifact.

**How to apply:** Use the package-management skill for supported root installations; when directory selection is required and unsupported by the callback, use a scoped package-manager command without bypassing the package firewall.