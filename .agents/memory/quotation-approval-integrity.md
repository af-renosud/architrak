---
name: Quotation approval integrity
description: Content coverage, prepared-proposal versions, linked questions and mutable translation approval.
---

Automatic extraction coverage must be bidirectional: preserve every source segment, and reject automatic candidate content not attributable to that item's source. This is not a veto on explicitly saved or approved human content.

**Why:** A candidate containing both correct descriptions plus another item's complete specification could pass a presence-only comparison with unchanged totals.

**How to apply:** Test additive contamination as well as missing/shifted passages. Shared specifications are legitimate only when independently present in each relevant source section.

Prepared proposals belong to their preparation-time quotation, lines and translation, not the state found when Apply is clicked.

**Why:** A request-time concurrency check alone lets an old proposal overwrite a newer successful extraction.

**How to apply:** Persist the preparation fingerprint and compare it under replacement locks; reject legacy proposals lacking it. Preserve line-linked questions independently of the line's checked/unchecked flag.

Translation approval belongs to exact content. Inline changes must invalidate approval before any client-facing surface can read them.

**Why:** The portal and package gates intentionally trust finalised status; retaining that status after editing publishes unchecked content. Verification and approval also need a version-bound commit to prevent concurrent edits.

**How to apply:** Clear approval and PDF cache metadata atomically with content changes, bump the PDF version, and reject stale finalisation.

Review versions must bind independent source evidence as well as visible content.

**Why:** Confirming a source baseline can change the applicable approval rules without changing the quotation's descriptions or financial header. A content-only fingerprint misses that change.

**How to apply:** Bind source confirmation and correction metadata into the reviewed decision version, and compare it again under the approval locks. Keep fixtures for source evidence independent from tests that deliberately installed invalid extraction.

List readiness must not download every original PDF, but deferred byte checks are not proof of verification. Authoritative approval, publication and signature actions still verify the source. Signature package content versions must ignore generated PDF-cache and envelope transport metadata while including authored content, context versions and source evidence.

**Why:** List refreshes otherwise perform repeated object-storage work; conversely, comparing complete records while constructing an envelope creates false stale-version conflicts from the application's own transport writes.

**How to apply:** Use the database-only decision projection for cards, explicitly identify deferred verification, and keep content-bound receipts for new signature packages so a retry cannot send an outdated package.

Stale signature-package guards need a recovery path, not just a rejection. Reconcile provider status before retiring an outdated envelope; only a definitely unsent draft can be rebuilt automatically, preserving its original receipt and an audit of retirement.

**Why:** Persisting an envelope before checking for content changes otherwise traps every retry on the same stale receipt. A failed send response is not proof that the provider never sent it.

Model-based extraction and totals recovery belong exclusively to candidate preparation, never candidate application.

**Why:** A second model response can alter rows or totals after the user reviewed the preview, even when the source and working-version fingerprints still match.

**How to apply:** Revalidate stored evidence deterministically during apply. Any new recovery result is a new proposal requiring fresh approval.

Line review colours and contractor questions have independent lifecycles. Reflagging or editing a line must never replace authored question wording, and unflagging alone must never withdraw it. Withdrawal is explicit and reversible; sent wording is immutable and amendments belong in the conversation.

**Why:** Operators could not readily reopen saved questions, and colour/progress/note updates could silently overwrite or hide them. A saved draft is valuable authored content even when no conversation messages exist.

**How to apply:** Preserve questions across all line updates, show read/edit and withdrawn-history access, and freeze the exact question snapshot before dispatch. Treat a dispatch-frozen question as retryable but not editable, even when delivery fails.

Architect source confirmation records the original PDF digest and human-confirmed TTC. The user may explicitly confirm a stored original-extraction total against the PDF without retyping; never substitute a mutable working header or row sum. Human corrections and approval are not gated by an OCR manifest or translation semantic model, including legacy illustrated evidence. Financial corrections must reconcile exact cents with actual VAT, discounts and options. Automatic extraction acceptance remains strict.

**Why:** Stored parser flags survive ordinary description edits; a line-only receipt survives contradictory header edits. Neither is current approval evidence.

**How to apply:** Use version-bound transactional human saves, immutable PDF/TTC receipts and actor/time before-and-after audit. Ordinary Save/Approve distinguishes human review from machine verification. Canonicalize receipt keys; preserve manual translations, source bytes and signed snapshots. Signing corrected packages must contain the original PDF and cannot fall back to translation-only evidence.

Explain source checks in terms of the user's task: a check not recorded, an actual numerical difference, or missing financial information. Never describe a missing internal receipt as proof of an incorrect quotation, or invent an old-import explanation without evidence. Essential reasons and actions stay visible; accessible help supplements them.

**Why:** The user explicitly found internal verification terminology and successive hidden requirements impossible to relate to normal quotation review.

**How to apply:** Show known financial gaps and provisional comparisons before source confirmation; preserve deliberate human confirmation and server safeguards without requiring needless retyping.