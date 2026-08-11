---
name: ESM-only deps must be bundled, not external
description: Why ESM-only npm packages break the CJS production bundle when left external, and how to fix/verify.
---

The production server is bundled by esbuild to CJS with most deps marked external. An ESM-only dependency (e.g. `p-limit` v7+, `exports`-only, `type: module`) left external compiles `import x from "pkg"` to `__toESM(require("pkg"), 1)`; under Node's `require(esm)` the resulting `.default` is not callable, crashing at runtime with `(0 , X.default) is not a function` — dev (tsx) works fine, so it only shows in the published app.

**Why:** the email-doc sweeper crashed every minute in production because `p-limit` was external.

**How to apply:** when adding a dependency to server code, check if it is ESM-only (`"type": "module"` + no CJS export); if so, add it to the bundling allowlist in the build script. Verify with `grep 'require("pkg")' dist/index.cjs` (should be absent) and a smoke boot `NODE_ENV=production node dist/index.cjs` — note the runtime env parser reads process.env, so without NODE_ENV=production a local boot takes the dev/vite branch and crashes for unrelated reasons.
