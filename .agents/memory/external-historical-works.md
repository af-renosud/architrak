---
name: External historical works
description: Migrated projects need lightweight historical cost tracking without document processing.
---
Projects may have started outside ArchiTrak with completed Devis whose costs still need to appear in rolling certificate project overviews.

**Why:** The user explicitly requested external references, short descriptions and HT/TTC values without uploading, scraping or analyzing documents, alongside a second budget tracking lane.

**How to apply:** Keep external historical cost tracking separate from document-processing workflows. Do not treat a recorded completed-work value as proof of payment or an ArchiTrak-issued certification.

External-work amounts need to support pasting formatted spreadsheet currency, including French decimal commas, grouping spaces and euro symbols.

**Why:** The user explicitly identified retyping copied financial figures as a human-error risk and wants the application to interpret the pasted value instead.

**How to apply:** When implementing amount-entry improvements, preserve copy/paste rather than requiring manual reformatting. Distinguish unambiguous formatting from ambiguous numbers; never silently guess or change the monetary value.
