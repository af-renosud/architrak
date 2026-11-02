---
name: Supporting PDF lifecycle
description: Preserve quotation originals and avoid deleting inputs of concurrent package builds.
---
Supporting PDFs are separate attachments, appended to the client package; never rewrite the original quotation.

**Why:** The approved use case is adding drawings/specifications without altering the supplier's original document.

**How to apply:** Preserve original downloads and append attachments in the selected order only to the complete package.

The document pop-out must offer an explicit original-only choice for contractor quotations and invoices.

**Why:** The user needs to inspect and download the simple contractor-supplied document without translations, added annotations, or other package pages.

**How to apply:** Both preview and download must use retained original bytes when that choice is selected; do not regenerate a lookalike from extracted data.

Removal unlinks the attachment but retains immutable object bytes for now.

**Why:** Immediate object deletion can break an in-flight package build that already read the attachment list.

**How to apply:** Any future storage cleanup must use delayed reference-aware garbage collection rather than deleting bytes inside the remove request.