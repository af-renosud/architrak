---
name: Multi-package dependency audits
description: Scope dependency remediation across independently installed artifacts, not just the root application.
---

Audit every independently installed package tree when fixing project-wide dependency findings.

**Why:** The project dependency scanner includes artifact lockfiles. A clean root npm audit can coexist with vulnerable versions in the mockup sandbox.

**How to apply:** Locate tracked lockfiles, inspect all nested occurrences of affected packages, and run scoped audits/build checks for each package tree. Report unrelated remaining findings separately rather than claiming the whole project is vulnerability-free.

The package installation callback rejects an empty package list and directory-selection flags such as `--prefix`.

**Why:** These inputs are validated as package names, so they cannot reinstall a separately installed artifact.

**How to apply:** Use the package-management skill for supported root installations; when directory selection is required and unsupported by the callback, use a scoped package-manager command without bypassing the package firewall.