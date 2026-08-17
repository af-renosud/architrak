import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the same-reference devis replacement flow (task #593).
 *
 * Verifies:
 *   1. Two non-void devis sharing the same normalized reference (devisNumber)
 *      each show the duplicate-reference banner with a "Mark this devis as
 *      replaced" action.
 *   2. Confirming the action supersedes the OLD devis: the banner disappears,
 *      the REPLACED (superseded) badge appears on its row, and the peer's
 *      banner is gone too.
 *   3. A replaced devis with a still-linked invoice shows the dangling-links
 *      warning in its expanded detail panel.
 *
 * Hermetic: fresh project/contractor per run; dev-login; the linked invoice
 * is inserted via SQL (no public API creates an invoice without a PDF).
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true plus
 * DATABASE_URL.
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`).toBe(true);
}

async function postOk<T = unknown>(api: APIRequestContext, url: string, body: unknown): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `${url} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`).toBe(true);
  return (await res.json()) as T;
}

test.describe("Devis — same-reference replacement (task #593)", () => {
  test("duplicate banner → mark replaced → badge + dangling-invoice warning", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-same-ref-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let projectId: number | null = null;
    let contractorId: number | null = null;
    const devisIds: number[] = [];

    try {
      await devLogin(context.request, email);
      const project = await postOk<{ id: number }>(context.request, "/api/projects", {
        name: `SameRef ${uniq}`,
        code: `SR-${uniq}`,
        clientName: "SR Client",
      });
      projectId = project.id;
      const contractor = await postOk<{ id: number }>(context.request, "/api/contractors", {
        name: `SR Co ${uniq}`,
      });
      contractorId = contractor.id;

      const sharedNumber = `REV-${uniq}`;
      const oldDevis = await postOk<{ id: number }>(context.request, `/api/projects/${projectId}/devis`, {
        contractorId,
        devisCode: `SR-OLD-${uniq}`,
        devisNumber: sharedNumber,
        descriptionFr: `Ancien devis ${uniq}`,
        amountHt: "1000.00",
        amountTtc: "1200.00",
        invoicingMode: "mode_b",
      });
      const newDevis = await postOk<{ id: number }>(context.request, `/api/projects/${projectId}/devis`, {
        contractorId,
        devisCode: `SR-NEW-${uniq}`,
        devisNumber: sharedNumber,
        descriptionFr: `Devis révisé ${uniq}`,
        amountHt: "1100.00",
        amountTtc: "1320.00",
        invoicingMode: "mode_b",
      });
      devisIds.push(oldDevis.id, newDevis.id);

      // Invoice still linked to the OLD devis → dangling warning after replace.
      await db.query(
        `INSERT INTO invoices (devis_id, contractor_id, project_id, invoice_number, amount_ht, tva_amount, amount_ttc)
         VALUES ($1, $2, $3, $4, '500.00', '100.00', '600.00')`,
        [oldDevis.id, contractorId, projectId, `FA-${uniq}`],
      );

      const page = await context.newPage();
      await page.goto(`/projets/${projectId}`);
      await page.getByTestId("tab-devis").click();

      // 1. Both rows carry the duplicate-reference banner.
      await expect(page.getByTestId(`banner-same-ref-${oldDevis.id}`)).toBeVisible();
      await expect(page.getByTestId(`banner-same-ref-${newDevis.id}`)).toBeVisible();
      await expect(page.getByTestId(`banner-same-ref-${oldDevis.id}`)).toContainText(`SR-NEW-${uniq}`);

      // 2. Mark the OLD devis as replaced.
      await page.getByTestId(`button-mark-replaced-${oldDevis.id}`).click();
      await expect(page.getByTestId(`dialog-mark-replaced-${oldDevis.id}`)).toBeVisible();
      await page.getByTestId("button-confirm-mark-replaced").click();

      // Badge appears on the old row; both banners disappear.
      await expect(page.getByTestId(`badge-devis-replaced-${oldDevis.id}`)).toBeVisible();
      await expect(page.getByTestId(`banner-same-ref-${oldDevis.id}`)).toHaveCount(0);
      await expect(page.getByTestId(`banner-same-ref-${newDevis.id}`)).toHaveCount(0);

      // DB truth: superseded + audit row with reason human_replace.
      const stateRow = await db.query("SELECT accounting_state FROM devis WHERE id = $1", [oldDevis.id]);
      expect(stateRow.rows[0].accounting_state).toBe("superseded");
      const audit = await db.query(
        "SELECT reason FROM accounting_state_changes WHERE devis_id = $1 ORDER BY id DESC LIMIT 1",
        [oldDevis.id],
      );
      expect(audit.rows[0].reason).toBe("human_replace");

      // 3. Expanded detail panel shows the dangling-invoice warning.
      await page.getByTestId(`row-devis-toggle-${oldDevis.id}`).click();
      await expect(page.getByTestId(`warning-replaced-dangling-${oldDevis.id}`)).toBeVisible();
      await expect(page.getByTestId(`warning-replaced-dangling-${oldDevis.id}`)).toContainText("1 invoice(s)");
    } finally {
      try {
        if (devisIds.length) {
          await db.query("DELETE FROM invoices WHERE devis_id = ANY($1::int[])", [devisIds]);
          await db.query("DELETE FROM accounting_state_changes WHERE devis_id = ANY($1::int[])", [devisIds]);
          await db.query("DELETE FROM devis_line_items WHERE devis_id = ANY($1::int[])", [devisIds]);
          await db.query("DELETE FROM devis WHERE id = ANY($1::int[])", [devisIds]);
        }
        if (projectId) await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
        if (contractorId) await db.query("DELETE FROM contractors WHERE id = $1", [contractorId]);
      } catch (err) {
        console.warn("[same-ref cleanup] swallowed:", (err as Error).message);
      }
      await db.end();
      await context.close();
    }
  });
});
