---
name: ArchiDoc production credential verification
description: How to safely confirm a production ArchiDoc credential rotation actually took effect.
---

- A configured secret is not evidence of a valid live credential. Rotate it through the secure secret flow, publish a fresh production process, and confirm a real authenticated mirror run succeeds for every resource before declaring recovery.
  **Why:** secret values and scope are intentionally opaque; an old process or rejected value can still report the secret as configured.
  **How to apply:** use safe deployment diagnostics for the per-resource outcomes and technical-lot HTTP status/validation; never log or surface secret values or upstream response bodies.

- Client and server secret variable names need not match. A caller's `_NEXT` value may be the credential accepted by the server's main secret.
  **Why:** assuming that an unsupported server-side `_NEXT` variable makes the caller's `_NEXT` invalid confuses local configuration names with the bearer value sent over HTTP.
  **How to apply:** compare safe, bounded authentication outcomes against supported endpoints before recommending a rotation or precedence change; never infer validity from variable names alone.