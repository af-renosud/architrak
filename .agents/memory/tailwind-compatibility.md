---
name: Tailwind compatibility
description: Preserve existing styling when changing Tailwind theme definitions or removing migration compatibility rules.
---

Keep the pre-migration visual scale unless a redesign is explicitly requested; do not remove compatibility rules just because newer Tailwind defaults compile successfully.

**Why:** The security-driven Tailwind major migration was approved to unblock publication, not to redesign the app. Existing application custom properties share names with Tailwind 4 theme variables, especially shadows. Reusing those variables can silently change component appearance even when builds pass. Inline theme values avoid that collision.

**How to apply:** When adjusting theme definitions, compare rendered styles as well as generated CSS. Preserve keyboard focus in forced-colors mode with the modern hidden-outline utility; an extra utility with the old name can lose to Tailwind's built-in rule in cascade order.

A CSS import-resolution failure after dependency changes can be a stale installed package tree, not a stylesheet incompatibility.

**Why:** This workspace retained Tailwind 3 and older integration packages after the manifest and lockfile had moved to Tailwind 4. The compatibility compiler could not resolve the CSS import until the installed tree was synchronized.

**How to apply:** Compare installed package versions with the lockfile before editing CSS or weakening compatibility tests. Synchronize existing declared dependencies first when they disagree.