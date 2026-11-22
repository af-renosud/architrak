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

## Integrated release verification

The private-source scenario also saves draft English wording and overview
context through the actual correction service, reopens it, saves rich line
context through the transactional storage method, and rejects stale versions.
Original French rows, stable IDs, amounts and unrelated paid evidence survive.
Draft translation preparation is eligible; incomplete English does not qualify
for approval. This verifies persistence, not the quality of a generated English
translation: no fresh provider translation was requested in this scenario.

The background-job suite covers persisted checkpoints, owner fencing, retries
and interrupted runs. Strict parser tests reject incomplete layouts, missing
charges and inconsistent totals while retaining section qualifications.
The integrated browser journey checked selective wording recovery, save/reopen,
indicative source-reviewed budgets, and unchanged financial/approval state.
It found a false own-save conflict; a narrow repeat confirmed its resolution.

The full pre-publish gate passed after approval fixtures were corrected to
contain English wording: dependency audit, currency conventions, TypeScript,
3,844 tests (17 skipped), production build including schema/migration checks,
and production-bundle health check with clean shutdown. Opt-in private-source
tests were run separately because the PDF must not be committed.

### Publication and live recovery

1. Publish the verified revision yourself. Local checks do not publish it.
2. Open the existing Massey DV261090 quotation, not a new duplicate upload.
3. Choose re-scrape/preparation. Leave the panel while it works; the current
   quotation does not change merely because a candidate is ready.
4. Compare the prepared rows and source passages against the original PDF.
   The isolated source gave HT 412,465.90 and TTC 453,712.49 across 167 rows,
   one unpriced. Matching totals alone are not permission to apply.
5. If the quotation still has no protected edits or financial links, explicitly
   approve and apply the reviewed candidate. If protection now prevents full
   replacement, preserve it and use selective wording recovery; never remove
   evidence to force application.
6. Review/save English and context, then use the normal approval checklist.
   Client sharing, signing and emails remain separate deliberate actions.

### Read-only checks after publication

Confirm the published revision is healthy, inspect extraction job state and
candidate provenance, and compare live totals/row count only after the operator
has applied the candidate. Check the original PDF is unchanged and the unrelated
paid certificate is untouched. Verify saved context survives reopening.
Do not create a baseline, apply a candidate, approve, send or sign as part of
this read-only verification.
