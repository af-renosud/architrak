---
name: Production query parameter path
description: Production SQL callback can return an empty transaction without executing an unparameterized query.
---
Use the parameterized executeSql path, including `params: []` for static reads.

**Why:** Unparameterized production SELECT calls repeatedly reported success with only START TRANSACTION / ROLLBACK, even for an invalid column. The parameterized path returned actual rows and SQL errors. An empty transaction output is not evidence of an empty table or missing record.

**How to apply:** When investigating production, pass parameters explicitly and require a result header or actual result before drawing conclusions.
