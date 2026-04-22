# Browser test: inline-edit French description on Devis Line Items

This test plan is meant to be executed via the `runTest()` testing skill (Playwright-based).
It exercises the inline-edit French description flow on the Devis Line Items table
introduced in task #66 (`inline-edit-french-line-items.md`).

## What it covers
- Happy path: click cell → edit → Save → toast "Description updated", change persists via
  `PATCH /api/line-items/:id` and is reflected in the row.
- Escape path: edit then press Escape → previous text restored, no PATCH issued.
- Error path: PATCH is intercepted at the network layer and forced to fail (500).
  Component shows destructive toast "Couldn't update description", restores the
  previous text and exits edit mode; the database is unchanged.

## Prerequisites
- App running locally (`npm run dev`) with `NODE_ENV=development`.
- Dev-only login endpoint enabled: `POST /api/auth/dev-login {email}`
  (registered in `server/auth/routes.ts`, gated on `NODE_ENV !== "production"`).

## Test plan (paste into runTest as `testPlan`)

```
Goal: Browser-test the inline-edit French description flow on the Devis Line Items table.

IMPORTANT — execute every step fresh in this run. Do NOT reuse any project/devis/line-item
ids from previous test runs. Always use the ids returned by the POSTs in steps 4–8.

1. [New Context] Create a new browser context.
2. [API] POST /api/auth/dev-login Content-Type:application/json body
   {"email":"test-inline-edit@local.test"}. Expect 200 and Set-Cookie connect.sid.
   Reuse this cookie for all subsequent [API] and [Browser] requests.
3. let U = nanoid(6).
4. [API] POST /api/projects body {"name":"InlineEdit Test "+U,"code":"IE-"+U,
   "clientName":"Test Client"} → 201, save id as projectId.
5. [API] POST /api/contractors body {"name":"Inline Edit Co "+U} → 201,
   save id as contractorId.
6. [API] POST /api/projects/${projectId}/devis body {"contractorId":${contractorId},
   "devisCode":"DEV-"+U,"descriptionFr":"Devis for inline edit test",
   "amountHt":"1000.00","amountTtc":"1200.00","invoicingMode":"mode_b"} → 201,
   save id as devisId.
7. [API] POST /api/devis/${devisId}/line-items body {"lineNumber":1,
   "description":"Original FR description","quantity":"1","unit":"u",
   "unitPriceHt":"100.00","totalHt":"100.00"} → 201, save id as lineItemId.
8. [API] POST /api/devis/${devisId}/line-items body {"lineNumber":2,
   "description":"Second line for error path","quantity":"1","unit":"u",
   "unitPriceHt":"50.00","totalHt":"50.00"} → 201, save id as errorLineItemId.
9. [API] GET /api/devis/${devisId}/line-items. Assert array length 2 with both ids.
10. [Browser] Navigate to /projets/${projectId}.
11. [Browser] Click data-testid="tab-devis".
12. [Browser] Click data-testid="row-devis-toggle-${devisId}".
13. [Verify] cell-line-description-${lineItemId} text "Original FR description" and
    cell-line-description-${errorLineItemId} text "Second line for error path".

— Happy path —
14. [Browser] Click cell-line-description-${lineItemId}.
15. [Verify] textarea-line-description-${lineItemId} visible.
16. [Browser] Clear textarea, type "Updated FR description "+U.
17. [Browser] Click button-save-line-description-${lineItemId}.
18. [Verify] toast title "Description updated" appears within 5s; cell shows
    "Updated FR description "+U; textarea gone.
19. [API] GET /api/devis/${devisId}/line-items. Assert id=lineItemId description
    is "Updated FR description "+U (round-trip through PATCH /api/line-items/:id).

— Escape path —
20. [Browser] Click cell-line-description-${lineItemId}.
21. [Browser] Clear textarea, type "Should NOT be saved "+U.
22. [Browser] Press Escape on the textarea.
23. [Verify] textarea gone; cell still shows "Updated FR description "+U.
24. [API] GET /api/devis/${devisId}/line-items. Assert description unchanged.

— Error path (forced PATCH 500 via Playwright route interception) —
25. [Browser] page.route("**/api/line-items/"+errorLineItemId, async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ status: 500, contentType: "application/json",
          body: JSON.stringify({ message: "Forced test failure" }) });
      } else { await route.continue(); }
    });
26. [Browser] Click cell-line-description-${errorLineItemId}.
27. [Verify] textarea-line-description-${errorLineItemId} visible.
28. [Browser] Clear textarea, type "Attempted edit that will fail "+U.
29. [Browser] Click button-save-line-description-${errorLineItemId}.
30. [Verify] destructive toast title "Couldn't update description" appears within 5s;
    textarea gone; cell still shows "Second line for error path".
31. [Browser] page.unroute("**/api/line-items/"+errorLineItemId).
32. [API] GET /api/devis/${devisId}/line-items. Assert id=errorLineItemId description
    still "Second line for error path".
```

## Relevant technical context
- UI: `client/src/components/devis/DevisTab.tsx` (LineItemWithCheck, ~L1219).
- Backend route: `PATCH /api/line-items/:id` in `server/routes/devis.ts` (~L419).
- Test ids: `cell-line-description-<id>`, `textarea-line-description-<id>`,
  `button-save-line-description-<id>`, `button-cancel-line-description-<id>`.
- Toast titles: success `Description updated`, failure `Couldn't update description`
  (variant `destructive`).
- Devis line items table only renders for `invoicingMode === "mode_b"`.
