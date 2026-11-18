# Quotation review release verification

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
