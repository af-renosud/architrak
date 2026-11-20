# Quotation review release verification

## Final integrated verification — 20 November 2026

The consolidated workflow is ready for the user's publication decision. No production data, real email, signature invitation or payment was changed.

### Changes
- Approval, financial saves, stage progression, client publication and signing use shared structured decisions and version checks.
- Re-extraction prepares a preview; application uses the exact stored candidate without further model recovery.
- Review findings link to source pages and working fields; historical extraction evidence remains separate.
- The existing workspace provides side-by-side PDF access on laptops and a small-screen source toggle. Inline context/image editing and the visible translation approval action remain.
- Exact recovered context saves clear stale blockers without clearing newer drafts or pending images. Idle editor mounts no longer refresh the checklist unnecessarily.
- Approval actions now sit on the leading edge beneath the translation heading, away from the floating Jobs rail.

### Final release gates
The fresh complete `npm run prepublish-check` exited 0 after all application changes:
- Dependency audit: root had 5 moderate findings, zero high/critical; sandbox had zero findings. No temporary exception was needed.
- Currency conventions and TypeScript passed.
- 374 test files passed, 1 skipped; 3,685 tests passed, 10 skipped. Includes database/concurrency, source guards, extraction preparation/application and UI regressions.
- Production build passed; schema and applied migrations matched (155 journal entries).
- Production smoke boot served `/healthz` 200 and shut down cleanly with workers disabled.

### Authenticated browser evidence
One development-only pass used isolated synthetic clean and architect-corrected quotations:
- At 1366×768, unchanged clean approval required neither Save nor manual source-total entry.
- Inline text and an uploaded PNG survived autosave and reload.
- A real stale-revision rejection preserved local and remote context; explicit conflict resolution saved the chosen version.
- An injected optional AI 503 did not prevent ordinary context editing.
- Missing VAT navigated to the correct field. A mismatch blocked both UI save and direct API submission; the correct VAT saved and approved without repeating the existing baseline.
- At 768×900, PDF access, scrolling, source toggling and draft-preserving close controls worked.
- Read-only readiness separated translation approval from outstanding sending requirements.

The browser found the Jobs/approval overlap; the subsequent layout-only adjustment was covered by the final component suite, not a second browser pass.

### Limits and retained warnings
- Model ingestion was represented by seeded source-evidence fixtures; ingestion pipelines were covered by automated integration tests, not live AI calls.
- No real client-link publication, email or signature dispatch was exercised. Production verification remains a separate optional follow-up after publication.
- Small-screen sidebar close behaviour, the OPEN/edited label wording, and a ProseMirror whitespace warning were observed but did not block this journey.
- Large client chunks, dependency annotations, the migration script's CJS `import.meta` warning and an unconfigured smoke-test operator-alert email remain non-blocking warnings.
- The synthetic QA project was archived. Its immutable audit records and referenced PDF/image objects were retained rather than bypassing deletion safeguards.

### Publication and recovery
No schema migration or production backfill was added by this refactoring. Publish through Replit's Publishing tool when ready; this report does not certify a live deployment.

If a rollback is needed, restore the appropriate pre-change code checkpoint and republish after checking the schema diff. Do not restore or erase production review/payment data merely to revert the interface. Already-saved approvals and audit records are not undone by a code rollback.

---

## Earlier verification — historical, before this consolidation

## Scope

Development-only verification of the unified quotation review workspace.
No production quotation, client email, signature request or payment was changed.
Publishing remains a user action.

## Full pre-publish result

The complete `npm run prepublish-check` finished with exit code 0:

- Dependency audit passed: root package tree had five moderate findings,
  no high or critical findings; mockup sandbox had no findings. No temporary
  advisory exception was needed for this run.
- Bare-currency convention and TypeScript checks passed.
- Tests: 355 files passed, one skipped; 3,479 tests passed, ten skipped.
- Production build passed, including schema and applied-migration drift checks.
- Production bundle served `/healthz` with HTTP 200 in side-effect-free smoke
  mode against development, then shut down cleanly.

Non-blocking build warnings remain for large client chunks, dependency comment
annotations and a CJS `import.meta` use in the migration reconciliation script.
The smoke environment also warned that operator alert email is not configured.
Skipped tests are not claimed as passing, and moderate dependency findings are
not described as a vulnerability-free audit.

## Authenticated browser walkthrough

A uniquely labelled synthetic quotation was used with two items: EUR 200 HT
at 10% VAT and EUR 100 HT at 20% VAT, giving EUR 340 TTC.

Verified:

- Original PDF accessible alongside the editor.
- Missing VAT shown upfront and approval blocked.
- French/English edits, rich context and an owned image retained across row
  navigation and a full browser reload.
- PDF-backed VAT suggestions required explicit saving.
- A stale save preserved the local draft; non-overlapping foreign edits were
  combined without losing either author's wording.
- Approval recorded against the reviewed version.
- Original PDF hash, source TTC and quotation totals remained unchanged.
- Footer reachable at 1280×800 and 1280×720.

Two minor findings were corrected: footer actions overlapping contextual scroll
controls, and a stale error message remaining after successful rebase.

Browser coverage limitations:

- The concurrent edits did not overlap, so explicit per-field conflict choices
  were covered by component tests, not this browser walkthrough.
- The upload-pending gate was covered by deferred-request component tests;
  this browser run did not isolate a delayed upload.
- Source TTC confirmation was prepared through the API, not clicked in-browser.

## Recovery after publication

For an existing corrected quotation:

1. Open **Review/edit quotation** (or **Edit working quotation**).
2. Confirm that existing wording, context and images are present. Do not void
   or re-upload the quotation merely to recover missing VAT.
3. If the source TTC is already locked, leave it unchanged.
4. Choose **Recover missing VAT from original PDF**, where available.
5. Review the proposed per-item rates and the exact TTC comparison.
6. Choose **Save correction**. Wait for context/image saves to finish as well.
7. Review the latest approval checklist, acknowledge the review, then choose
   **Approve reviewed quotation**.

If recovery cannot establish exact source evidence or totals, it must remain
blocked: inspect the original rather than apply one blanket VAT rate or add a
balancing adjustment. If another editor changed the same content, compare the
versions and make an explicit choice; preserve the draft rather than force-save.
