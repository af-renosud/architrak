# Quotation workflow contract and consolidation audit

Audited 19 November 2026. This document describes **observed current behaviour** separately from the **target contract**. This audit changes no application behaviour, approvals, production records or financial policy.

## 1. User journey and ownership

**Review source → correct only what needs correcting → save changes → explicitly approve the saved version → deliberately share/send after action-specific prerequisites pass.**

No correction is required when the quotation is already correct. Translation approval, approval for signing, issuance of a client-review link and sending a signature request are different actions. “Approved” must name its scope; it does not prove delivery, signature or payment.

| Decision/action | Authority and required evidence | Successful result | Failure and recovery |
|---|---|---|---|
| Admit automated email PDF | Deterministic financial-document purpose and identity inside PDF; active project | Eligible attachment proceeds to extraction | Irrelevant/inactive project excluded; unreadable or ambiguous identity follows its existing distinct policy, never silently treated as eligible |
| Direct upload to selected project | Explicit operator upload and current upload guards | Original retained, extraction attempted, provisional reconciliation started | File/type/parse failure remains actionable; do not apply the email gate as a new blanket restriction to deliberate uploads |
| Accept automatic extraction | Source-bound evidence, complete accounting of printed rows, description/charge association, all-page coverage | Machine-supported working rows with original evidence retained | Source exception; use targeted source review or an explicit previewed re-scrape, never fabricate missing values |
| Confirm independent source TTC | Architect reads original PDF, enters its TTC and page, confirms; digest/version checked | One immutable baseline and actor/time audit, separate from editing/approval | Missing source/page/invalid amount/stale version blocks confirmation; reuse an existing valid baseline |
| Save wording/context | Architect owns working text; context has owned image references and revision checks | Saved content, original unchanged, relevant content version advanced | Preserve drafts on stale/save failures; missing VAT is not a reason to prevent a genuinely text-only save |
| Save financial correction | Actual VAT, discounts, inclusion and rounding; independent source baseline; exact-cent reconciliation; uncommitted figures | Entire batch and audit commit together | No partial save; identify all unresolved fields and any discrepancy; no default VAT or balancing item |
| Approve translation | Explicit human review of current saved source/wording/figures/context; live financial/source checks and exact version | Finalised translation plus actor/time/version receipt | Pending saves, stale version, financial/source problems block approval, with a direct recovery action |
| Advance to approved for signing | Stage-transition and quotation-source checks | Eligible workflow stage only | Must not impersonate sent or signed state; backward recovery follows existing audited rules |
| Publish on project client link | Active token and project membership; finalised translation; not void/provisional/superseded | Deliberate membership publication | Report link/accounting/translation prerequisites separately from review |
| Send individual client review link | Existing client-link service requirements and source-containing package | Explicit delivery operation | Keep recipient, source and package requirements distinct; do not equate link preparation with successful delivery |
| Send for signature | Current quotation guards, stage, translation-mode policy, contact, live insurance, questions or explicit scoped authorisation, signature lock | Explicit provider dispatch under existing orchestration | Existing signed evidence prohibits duplicate signature requests; failures remain retryable under existing send semantics |
| Reopen/edit approved content | Deliberate reopen or versioned working correction as currently permitted | New unapproved working interpretation | Never rewrite signed PDF/snapshots or let reopened rich content be treated as approved |

### Source confirmation is conditional, not universal

The clean machine-backed import branch can currently reach review without manual TTC entry. A legacy quotation lacking a verification receipt is directed to original-PDF confirmation. Financial corrections require an independent baseline. An existing valid baseline is reused.

The absence of an architect correction record is **not** a reason to refuse review or request a fake edit. The existence of a correction record is **not** proof that review occurred. Once a baseline exists, its source/financial boundary applies even to an otherwise unchanged quotation.

Missing source bytes are an operational failure, not evidence that the user entered incorrect figures. A mismatching source digest is an integrity failure. Neither can be dismissed as a warning.

## 2. Current implementation trace

Anchors are file paths and symbol/route names rather than fragile line numbers.

| Area | Current implementation and evidence |
|---|---|
| Email intake | `shared/email-financial-gate.ts`: `evaluateFinancialPdf`, `discardIrrelevantFinancialDecision`; `server/gmail/financial-pdf-triage.ts`: native/OCR transcription before deterministic decision. Email wording cannot qualify an otherwise irrelevant PDF. |
| Manual intake | `server/routes/devis.ts`: project upload → `processDevisUpload` → reconciliation; parser evidence originates in `server/gmail/document-parser.ts`. |
| Extraction evidence | `quotation-poste-table.ts`, `quotation-priced-evidence.ts`, `quotation-source-manifest.ts`: deterministic table recovery, source/row digests and bidirectional association rather than model confidence. Existing parser tests already cover cross-page descriptions and unaccounted cancelling charges. |
| Review preflight | `quotation-review-readiness.ts`: separate reads of quotation/lines/translation, baseline branch through correction snapshot and financial boundary, otherwise `quotationApprovalBlocker({reviewing:true})`. Returns version and `{key,message}` blockers. |
| Original confirmation | `architect-quotation-correction.ts`: `confirm` validates page/digest/current version, writes immutable baseline and audit; existing baseline cannot be overwritten. |
| Working save | Same service `save`: full stable-row batch; detects `financialProjection` changes, exact TTC baseline for financial changes; sets transaction-local correction permission; clears approval/PDF caches and increments context version. Text-only saves may retain incomplete finances. |
| Inline context | `devis-line-context.ts` and `storage.saveDevisLineContextGuarded`: owned asset validation, optimistic revision, translation-row lock, finalised guard, context version/cache invalidation. Context storage is separate from translated wording. |
| Approval route | `POST /api/devis/:id/translation/finalise`: reads state, optional/conditional request-version checks, financial boundary, source guard, draft/edited status, then `commitTranslationApproval`. |
| Approval commit | `translation-approval-commit.ts`: quotation/project/line/translation locks, fingerprint recheck, repeated financial projections, narrow transaction-local permission, finalised status and explicit receipt. Preserves background overwrite guard. |
| Stage advance | `PATCH /api/devis/:id`: controlled stage transitions, source guard before forward approved-for-signing transition; sent/signed states reserved for orchestration/webhooks. |
| Card readiness | `devis-readiness.ts`: batch-derived independent predicates; historical extraction flags, stage, translation mode, lot, description, questions, mirror insurance, contact. Not the same evaluator as human review. |
| Send enforcement | `archisign-envelopes.ts`: signature lock, archived/void/superseded/signed checks, source and translation coverage, stage, delivery/insurance/question requirements. Live insurance is authoritative, mirror readiness indicative. |
| Project client share | `client-project-share.ts`: `getPublishBlockReason` checks void/provisional/superseded and finalised status; membership visibility deliberately differs from rich-content visibility. Do not remove membership merely because wording was reopened; retain public-content approval gating. |
| Review UI | `QuotationApprovalReview.tsx`: pending work, latest version, explicit review checkbox; `ArchitectQuotationEditor.tsx`: separate dirty/financialDirty, source baseline, financial fields, conflict recovery, source PDF; `DevisTranslationSection.tsx`: visible approval and inline context. |
| Database protections | `migrations/0139_architect_quotation_corrections.sql`: immutable baseline/audit and original/row/translation overwrite guards. Approval transaction-local permission is not a disposable workaround. Read all later redefinitions before touching a trigger. |

## 3. Restriction inventory and disposition

“Duplicated” means consolidate the evaluation, **not remove the protection**. “Misplaced” means the check belongs to another action or needs current evidence, not historical flags. No restriction is declared obsolete merely because it was added during troubleshooting.

| Restriction / behaviour | Classification | Evidence and downstream action |
|---|---|---|
| Financial PDF purpose and active-project identity | Necessary | Synthetic intake tests plus existing financial gate; keep email and deliberate-upload paths distinct. |
| Automatic source-to-price/description coverage | Necessary | Priced evidence and poste-table tests; keep unsupported rows and equal-price identity checks. |
| Immutable source bytes, source TTC and audit | Necessary | Correction service + database migration; preserve independent baseline and source-containing packages. |
| Actual VAT/discount/inclusion/rounding and atomic financial batch | Necessary | Pure financial fixture tests and existing correction integration suite; no inferred 20% VAT or balancing. |
| Stable row IDs and linked evidence | Necessary | Correction service identity checks and integration suite; extraction removal remains a separate audited operation. |
| Explicit review without editing | Necessary, already supported | New baseline-without-correction characterisation and existing human-approval test; do not reimplement as a new feature. |
| Reusing valid source confirmation | Necessary, already supported | Baseline branch accepts reviewing without repeat transcription; keep source digest checks. |
| Revision locks, draft preservation, approval invalidation | Necessary | Working version, context queue tests and approval integration suite; retain across UI consolidation. |
| Transaction-local permission on corrected approval | Necessary | `quotation-approval-integrity.integration.test.ts` explicitly covers corrected approval and subsequent background-write refusal; never replace with a global bypass. |
| Repeated financial evaluation in preflight/route/guard/commit | Duplicated evaluation, necessary revalidation | Readiness calls boundary; finalise calls boundary then guard that calls boundary; commit reconstructs two financial projections. Consolidate rules; still recheck coherent current state under locks. |
| String parsing/deduplication of financial errors | Duplicated/fragile presentation | Readiness uses `includes`/`startsWith("Confirm the source TTC")` and `"PDF"` to classify. Replace with stable codes/targets after migrating callers. |
| Historical extraction flag in card after accepted human review | Misplaced | New `CURRENT GAP` test: guard allows approved human interpretation, pure card still reports unverified coverage. Base card on current action decision rather than raw history. |
| Replaced accounting state missing from pure card predicate | Missing parity, not weaker send enforcement | New `CURRENT GAP` test returns ready for synthetic superseded row; send route separately rejects it. Add common state restriction downstream. |
| Broad “Approved … ready to share” UI wording | Misplaced scope | Review UI success status does not evaluate token/accounting/recipient/send prerequisites. Name approved translation and show next action separately. |
| Source TTC form shown whenever no baseline exists | Misplaced emphasis | Editor exposes confirmation even when clean machine evidence can pass review; show it when the decision requires it, without hiding an available deliberate verification tool. |
| Re-extract-only instructions for failed legacy manifest | Obsolete as exclusive recovery wording | `quotationWorkingCoverageBlocker` says re-extraction required, while independent baseline + human review is supported. Replace guidance only after common resolution targeting is wired. Do not remove strict automatic manifest verification. |
| Blank VAT blocking a content-only save | Not observed in current save path | Service financialChanged and UI financialDirty already separate text saves. Keep regression tests; do not describe the historical issue as still universally broken. |
| Questions and live insurance for signing | Necessary, action-specific | Card uses count/mirror; send accepts explicit question authorisation and live verdict. Expose differences as waiting/authorisation/live-check states rather than weakening requirements. |
| Server expectedVersion/confirmedReview mandatory only with baseline | Uneven request contract | Finalise route makes these mandatory for baseline records; UI supplies them for all. Standardise explicit saved-version review downstream with compatibility tests, not silently auto-approve legacy callers. |
| Finalised status alone at project publish boundary | Boundary dependency requiring parity tests | Publish helper relies on upstream approval; send additionally evaluates source/translation guards. Consolidation must define shared prerequisites per action without making publishing and signing identical. |
| Mode A draft signature vs mode B finalisation | Existing policy, not an obsolete workaround | New mode characterisation and existing readiness tests; retain distinction unless user separately approves a policy change. |

## 4. Common decision model

### Implementation status — 2026-11-20

The source/financial evaluator and coherent versioned snapshots now serve review readiness, approval commit, approval-stage advancement, client-link publication and signature preflight. The project card uses the same evaluator with **source-byte checks explicitly deferred to the authoritative action**, rather than downloading every original PDF during list refreshes. A deferred byte check is informational, never evidence that unavailable bytes were verified.

Financial-save errors use the shared structured financial issues, including row and field targets. Content-only saves retain their separate existing transaction and do not require complete VAT. Independent TTC confirmation is required for a financial correction and for source evidence that cannot otherwise establish review eligibility; a clean machine-supported import does not acquire a blanket manual-transcription requirement.

Approval-stage commit compares its checked version under quotation/line/translation locks. Publication checks the common client-link decision inside the membership/audit transaction and verifies that the token is still active. Signature preparation binds a content version to new envelope audit receipts and checks it again before dispatch, including on retries. Older envelope receipts retain their existing compatibility rules; no receipt is invented for them.

An outdated signature envelope is recoverable through Retry: read its authoritative provider status under the signature lock; only a confirmed `draft` may be detached in an audited transaction and rebuilt with the latest PDF and a new receipt. Unavailable, already-dispatched or signed provider states must never be inferred to mean unsent. Retain the old audit and never overwrite its version to authorise old PDF bytes.

Action distinctions remain deliberate: Mode A may send a machine-supported draft translation; Mode B requires finalisation. The card retains its pre-existing additional lot/English-description completeness checks. Recipient checks, live insurance, explicit question authorisation, immutable signed evidence and package construction remain owned by their existing delivery orchestration. A source decision alone is not permission to send.

The following specification explains the vocabulary; the historical audit and its findings above document the starting point, not the current implementation. Extraction-exception presentation and the consolidated review interface remain the separately queued work.

One read-only evaluator of a coherent versioned snapshot, with action-specific decisions:

`action`, `version`, `allowed`, `issues[]`, and evidence references. Each issue has a stable `code`, `category`, `severity`, `target` (section/row/field/PDF page where known), user message and recovery action. Server mutation paths revalidate the same rules under the appropriate locks; a UI preflight is never authorisation by itself.

| Proposed category / example codes | Meaning | Recovery |
|---|---|---|
| `intake`: `DOCUMENT_IRRELEVANT`, `PROJECT_IDENTITY_AMBIGUOUS`, `SOURCE_UNREADABLE` | Admission decision; exclusion, ambiguity and unreadable are not interchangeable | Existing exclusion/review/retry policy |
| `source`: `SOURCE_CONFIRMATION_REQUIRED`, `SOURCE_DIGEST_MISMATCH`, `SOURCE_UNAVAILABLE` | Missing evidence, contradictory evidence or unavailable verification | Show original/confirm only where needed; restore/retry access; never force unrelated edits |
| `extraction`: `UNSUPPORTED_ROW`, `DESCRIPTION_CHARGE_UNVERIFIED`, `COVERAGE_INCOMPLETE` | Machine acceptance exceptions | Direct row/page review, audited correction or explicit re-scrape preview |
| `financial`: `VAT_MISSING`, `TOTAL_MISMATCH`, `DISCOUNT_INVALID`, `FIGURES_COMMITTED` | Actual financial issue or protected figures | List affected fields together; reconcile complete batch or use proper revision/amendment |
| `working_copy`: `UNSAVED_CONTENT`, `UPLOAD_PENDING`, `SAVE_FAILED`, `VERSION_CHANGED` | Latest visible work is not yet a settled reviewable version | Preserve draft, retry/compare/save; allow safe navigation |
| `approval`: `TRANSLATION_MISSING`, `REVIEW_REQUIRED`, `ALREADY_APPROVED` | Explicit content review lifecycle | Prepare or review current saved version; no dummy changes |
| `lifecycle`: `PROJECT_ARCHIVED`, `QUOTATION_REPLACED`, `QUOTATION_VOID`, `SIGNATURE_RECORDED` | Action-specific protection | Navigate to replacement/existing signed copy; no new send |
| `delivery`: `CLIENT_LINK_REQUIRED`, `RECIPIENT_MISSING`, `INSURANCE_CHECK_REQUIRED`, `QUESTIONS_AUTHORISATION_REQUIRED`, `PACKAGE_NOT_READY` | Requirements for selected outbound action, not wording save | Direct deliberate resolution, then deliberate send |
| `technical`: `VERIFICATION_UNAVAILABLE` | Cannot establish readiness | Retry; never display green readiness from unavailable checks |

Severity: `blocker` refuses that action; `warning` is advisory and does not secretly veto a later action; `info` explains history/status. Pending and technical failures must not be presented as incorrect data. Historical machine warnings remain historical after valid human resolution; they do not become forged machine-verification success.

No automatic “approve when last blocker clears”, no email/signature dispatch as a side effect of saving, and no silent approval migrations.

## 5. Verification map and limits

New tests are hermetic: no database writes, real PDF downloads, external model calls or personal data. Storage/source boundaries are mocked explicitly; the guard, readiness evaluator, parser helpers and arithmetic under test are real.

| Case | New test evidence | Existing complementary tests |
|---|---|---|
| Clean untouched import, source bytes changed/unavailable | `quotation-workflow-characterisation.test.ts` | `quotation-priced-evidence.test.ts` |
| Source confirmed without correction; corrected human text; legacy receipts | same | `quotation-human-approval.test.ts` |
| Missing VAT, exact TTC, content-only projection, numeric JSON | `quotation-workflow-fixtures.test.ts` | `quotation-review-numeric-boundary.test.ts`, `architect-quotation-correction.integration.test.ts` |
| Pool heater continuation and unsupported router | same | `quotation-poste-table.test.ts`, `quotation-priced-evidence.test.ts` |
| Equal-price distinct joinery and swapped descriptions | same | `quotation-eighteen-section-regression.test.ts`, `quotation-source-manifest.test.ts` |
| Context/wording changes invalidate version | `quotation-workflow-characterisation.test.ts` | `devis-line-context.test.ts`, `quotation-approval-integrity.integration.test.ts` |
| Approved human receipt, signed evidence, replaced-state card gap, mode distinction | same | `devis-readiness.test.ts`, `quotation-replacement.integration.test.ts` |
| Inline context, stale saves and approval UI | Existing component suites exercised in this audit | `quotation-approval-review.test.tsx`, `devis-line-context-editor-resync.test.tsx` |
| Financial plan exclusion and active-project identity | `quotation-workflow-fixtures.test.ts` | Existing financial-admission tests |

The `CURRENT GAP` tests intentionally freeze an undesirable existing behaviour to make the later change explicit. When fixing it, change the expectation and remove that label in the same commit. Do not preserve the gap just to keep a test green.

This audit does not claim a new database integration run or authenticated browser walkthrough. The existing database tests above are inspected evidence and scheduled regression coverage for consolidation/release, not proof that this audit exercised live SQL. Source digest and original PDF storage semantics still require those integration tests at implementation time.

Audit verification result: **23 new characterisation/fixture tests passed**, plus **99 existing regression tests across nine suites**, and `npm run check` and `git diff --check` passed. No runtime source files or migrations were changed, so no application restart, live-model call or browser run was needed. This is not a full pre-publish result; that remains the final release milestone.

## 6. Bounded consolidation order

1. **Shared rules:** centralise typed decisions, snapshot/version binding and financial/source evaluation; migrate review preflight, finalise, stage, card, share and send callers with explicit per-action requirements. Preserve authoritative commit-time checks and lock ordering.
2. **Extraction exceptions:** map existing receipts and findings into those codes; close proven coverage gaps only. Keep strict automatic verification separate from current human resolution.
3. **Interface:** consume structured decisions, target exact fields, retain inline context and visible approval, group financial exceptions, collapse history, keep original PDF alongside corrections.
4. **Release:** run the integrated regression matrix and one authenticated browser pass, then complete pre-publish checks on final code. No production repair or automatic publication.

Removal conditions: a duplicate evaluator can be removed only after every caller is migrated and parity/negative-path tests pass. A compatibility branch or database guard must not be deleted because it is inconvenient. All additions must preserve source authority, signed snapshots, questions/images and financial lineage.

### Policy boundaries and unresolved decisions

No new user decision is required to begin the approved consolidation: preserve existing mode A/B signing differences, question-authorisation rules and distinct automated/manual intake policies. A proposal to make all signing require finalised translation, to replace independent TTC transcription with an extracted suggested baseline, or to change retention of unreadable documents is a separate policy change and requires approval. It is not silently included here.

The current empty/missing extraction-metadata paths, legacy human receipts and publish-helper reliance on finalised status warrant explicit negative-path compatibility tests before tightening behaviour. Do not automatically invalidate or approve historical documents as a migration. If a genuine record cannot fit the established evidence rules safely, report that specific case rather than inventing another global bypass.
