# Native quotation recovery verification

Existing quotation re-scrapes opt into native recovery before rendering or AI.
New uploads retain the existing identity/classification path: the strict table
reader alone does not establish a contractor or project identity.

The private DV261090 source was verified through prepare and explicit apply in
a disposable PostgreSQL schema, including a paid certificate sourced from a
different quotation. No production record was changed.

## Repeat the focused checks

Supply the original PDF through a local, untracked path; do not commit it.

```sh
RECOVERY_SOURCE_PDF=/path/to/private/source.pdf RUN_ARCHITECT_DB_TESTS=1 \
  npx vitest run \
  server/__tests__/native-quotation-recovery.integration.test.ts \
  server/__tests__/architect-quotation-correction.integration.test.ts \
  server/__tests__/long-pdf-pipelines.integration.test.ts \
  server/services/__tests__/quotation-numbered-table.test.ts
npm run check
```

The native integration test forbids AI and image-renderer calls and replaces
outbound hooks. It copies table definitions into an isolated development schema
with its own sequences and drops that schema afterwards. It tests real service
transactions, not production data. The copied tables do not include production
triggers; the architect-correction suite separately exercises its audit triggers.

Expected results for the investigated source: 167 work rows, including one
unpriced row; HT 412,465.90 and TTC 453,712.49. These are test expectations, not
production correction constants. Section text is retained with the following
work item. Unpriced unit prices persist as null, with original blank-column
evidence retained; non-null line totals still use zero contribution.

The broader background-job recovery, incomplete-draft workflow and final
integrated browser/pre-publish verification remain separate planned work.
Publication and application to the live quotation require explicit actions.
