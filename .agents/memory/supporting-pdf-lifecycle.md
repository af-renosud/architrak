---
name: Supporting PDF lifecycle
description: Preserve quotation originals and avoid deleting inputs of concurrent package builds.
---
Supporting PDFs are separate attachments, appended to the client package; never rewrite the original quotation.

**Why:** The approved use case is adding drawings/specifications without altering the supplier's original document.

**How to apply:** Preserve original downloads and append attachments in the selected order only to the complete package.

Removal unlinks the attachment but retains immutable object bytes for now.

**Why:** Immediate object deletion can break an in-flight package build that already read the attachment list.

**How to apply:** Any future storage cleanup must use delayed reference-aware garbage collection rather than deleting bytes inside the remove request.