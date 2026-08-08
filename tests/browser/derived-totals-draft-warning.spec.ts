import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for Task #339 — the "totals derived from line items" warning
 * must be VISIBLE to the operator in the draft review panel.
 *
 * Task #338 taught the extraction validator to derive amountHt/amountTtc from
 * the line-item sum when the AI misses both document totals, attaching a
 * `field: "amountHt"` warning and capping confidence at 40. Unit tests cover
 * the validator; this spec verifies the operator-facing surface: a derived
 * €227k total must not look like a clean extraction.
 *
 * Seeds a draft devis whose validation_warnings contain the derived-totals
 * warning (exactly the shape the validator emits) with ai_confidence=40 and
 * the derived amounts persisted, then asserts in the DraftReviewPanel:
 *   1. the derived-totals warning text is visible (generic warnings list),
 *      plus the amber per-field badge next to the Amount HT input;
 *   2. the reduced confidence (40%) is displayed in the rose indicator;
 *   3. the derived amounts are pre-filled in the editable HT/TTC fields.
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true (dev-login)
 * plus DATABASE_URL (drafts are produced by the upload pipeline; there is no
 * public API to create one, so we flip a seeded devis to draft via SQL).
 */

const SEED_PREFIX = "e2e-derived-totals-";

// Mirrors the production incident that motivated task #338 (derived ~€227k).
const DERIVED_HT = "227000.00";
const DERIVED_TTC = "272400.00";
const WARNING_MESSAGE =
  "Document totals were missing from the extraction — HT derived from the sum of 3 line items (227000), TTC derived as 272400 (20% TVA). Verify the amounts against the PDF before confirming (line amounts may be VAT-inclusive).";

interface Seeded {
  projectId: number;
  contractorId: number;
  devisId: number;
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function postOk<T = unknown>(
  api: APIRequestContext,
  url: string,
  body: unknown,
): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `${url} failed: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seeded> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `${SEED_PREFIX}project-${uniq}`,
    code: `DT-${uniq}`,
    clientName: "Derived Totals Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `${SEED_PREFIX}co-${uniq}`,
  });
  const devis = await postOk<{ id: number }>(
    api,
    `/api/projects/${project.id}/devis`,
    {
      contractorId: contractor.id,
      devisCode: `DT-${uniq}.1`,
      descriptionFr: `Derived totals draft ${uniq}`,
      amountHt: DERIVED_HT,
      amountTtc: DERIVED_TTC,
      invoicingMode: "mode_b",
    },
  );

  // Flip to draft with the exact warning payload + capped confidence the
  // validator emits for the derived-totals case (see extraction-validator.ts
  // Task #338 block; unit-tested in shared/__tests__/extraction-validator.test.ts).
  const warnings = [
    {
      field: "amountHt",
      expected: 227000,
      actual: 0,
      message: WARNING_MESSAGE,
      severity: "warning",
    },
  ];
  await db.query(
    `UPDATE devis
       SET status = 'draft',
           validation_warnings = $1::jsonb,
           ai_confidence = 40
     WHERE id = $2`,
    [JSON.stringify(warnings), devis.id],
  );

  return { projectId: project.id, contractorId: contractor.id, devisId: devis.id };
}

async function cleanup(db: Client, s: Seeded | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM devis_line_items WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[derived-totals cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Draft review — derived-totals warning is visible (task #339)", () => {
  test("warning text, reduced confidence, and pre-filled derived amounts all render", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let seeded: Seeded | null = null;
    try {
      await devLogin(context.request, `${SEED_PREFIX}${uniq}@local.test`);
      seeded = await seed(context.request, db, uniq);

      const page = await context.newPage();
      await page.goto(`/projets/${seeded.projectId}`);
      await page.getByTestId("tab-devis").click();

      // The draft row exposes the Review draft quick action.
      const reviewBtn = page.getByTestId(`button-review-draft-${seeded.devisId}`);
      await expect(reviewBtn).toBeVisible({ timeout: 15_000 });
      await reviewBtn.click();

      const dialog = page.getByTestId("dialog-draft-review");
      await expect(dialog).toBeVisible();

      // 1. Derived-totals warning is visible in the generic warnings list,
      //    BEFORE the operator confirms anything.
      const warningsSection = dialog.getByTestId("section-validation-warnings");
      await expect(warningsSection).toBeVisible();
      const warning = dialog.getByTestId("warning-amountHt-0");
      await expect(warning).toBeVisible();
      await expect(warning).toContainText("Document totals were missing from the extraction");
      await expect(warning).toContainText("derived from the sum of 3 line items");
      await expect(warning).toContainText("Verify the amounts against the PDF before confirming");

      // The per-field amber badge also flags the Amount HT input directly.
      // (Badges rendered by fieldWarnings("amountHt") show the severity.)
      await expect(
        dialog.locator("div", { has: page.getByTestId("input-draft-amount-ht") })
          .getByText("warning", { exact: true })
          .first(),
      ).toBeVisible();

      // 2. Reduced confidence is displayed — 40% (capped by the validator).
      const confidence = dialog.getByTestId("indicator-ai-confidence");
      await expect(confidence).toBeVisible();
      await expect(confidence).toContainText("40%");
      await expect(confidence).toContainText("AI Confidence");

      // 3. Derived amounts are pre-filled in the editable fields.
      await expect(dialog.getByTestId("input-draft-amount-ht")).toHaveValue(DERIVED_HT);
      await expect(dialog.getByTestId("input-draft-amount-ttc")).toHaveValue(DERIVED_TTC);
    } finally {
      try {
        await cleanup(db, seeded);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
