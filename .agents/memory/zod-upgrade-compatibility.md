---
name: Validation library compatibility
description: Zod upgrades must include form resolvers and schema adapters.
---

Upgrade Zod together with its React Hook Form resolver and Drizzle schema adapter; a successful TypeScript check alone does not prove invalid submissions still display field errors.

**Why:** The older resolver reads `error.errors`, whereas Zod 4 exposes `error.issues`. It can throw instead of reporting validation errors even when application compilation passes.

**How to apply:** Test both invalid submissions and valid submissions with defaults. Model form input and parsed output separately when defaults or coercions change their types, including the shared FormField wrapper. Never route security fixes through a legacy compatibility import just to silence type errors.
