---
name: GitHub connector source sync
description: How to preserve exact Git history when Replit's GitHub connector is available but command-line Git has no usable credential.
---

The Replit GitHub connector can have repository write scope while HTTPS and SSH command-line pushes remain unauthenticated. In that case, do not request or expose a personal token and do not squash the authoritative source merely to move it remotely. Recreate missing blobs, trees, and commits through GitHub's Git Data API, require every returned object SHA to match the local object, and update the branch ref with force disabled.

**Why:** Connector credentials are injected only through the connector proxy and are not automatically available to command-line Git. Exact object verification preserves the reviewed commit identity and avoids silently rewriting release history.

**How to apply:** First prove the remote branch is an ancestor and that held branches are not contained in the local history. Upload objects parent-first, reject any SHA mismatch, move the branch with a non-force ref update, then verify a fresh remote clone and run the release gate from that clone.