---
name: Client worksheet calculation parity
description: The client worksheet screen, API and Excel download must always produce the same figures.
---
The client worksheet's figures (line totals, VAT per real rate, TTC, deposit, "Not priced" handling) are defined once in shared code; the Excel export's live formulas must reproduce exactly the same results, and downloads must only start once all edits have saved.

**Why:** the client's earlier hand-built spreadsheet computed VAT from the wrong cell; the user wants the app and the downloaded workbook to agree to the cent.

**How to apply:** any change to a worksheet calculation rule changes the shared compute and the export formulas together, and the formula-recalculation test must keep passing.
