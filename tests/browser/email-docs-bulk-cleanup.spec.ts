import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for Task #550 — bulk clean-up of email documents.
 *
 * Verifies on /email-documents:
 *   1. The Skipped filter shows skipped rows with selectable checkboxes.
 *   2. "Select all shown" selects every visible row.
 *   3. "Remove selected" → confirm dialog → bulk-dismiss permanently
 *      purges the skipped rows (they disappear from the list and the DB).
 *
 * Seeding: skipped email_documents rows via direct SQL.
 * Requires ENABLE_DEV_LOGIN_FOR_E2E=true and DATABASE_URL.
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()})`).toBe(true);
}

test("select-all on Skipped filter bulk-purges skipped docs", async ({ browser }) => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const ids: number[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const r = await db.query(
        `INSERT INTO email_documents (email_message_id, email_from, email_subject, attachment_file_name, document_type, extraction_status, updated_at)
         VALUES ($1, 'e2e550@test.local', 'E2E550 bulk cleanup', $2, 'unknown', 'skipped', NOW())
         RETURNING id`,
        [`e2e550-${Date.now()}-${i}`, `e2e550-${i}.pdf`],
      );
      ids.push(r.rows[0].id);
    }

    await devLogin(context.request, `e2e550-${Date.now().toString(36)}@local.test`);
    const page = await context.newPage();

    await page.goto("/documents");
    // Switch to the Skipped filter.
    await page.getByTestId("select-status-filter").click();
    await page.getByRole("option", { name: /skipped/i }).click();

    // Seeded rows visible with checkboxes.
    for (const id of ids) {
      await expect(page.getByTestId(`card-email-doc-${id}`)).toBeVisible();
      await expect(page.getByTestId(`checkbox-select-doc-${id}`)).toBeVisible();
    }

    // Select all shown, then remove.
    await page.getByTestId("checkbox-select-all").click();
    for (const id of ids) {
      await expect(page.getByTestId(`checkbox-select-doc-${id}`)).toHaveAttribute("data-state", "checked");
    }
    await page.getByTestId("button-dismiss-selected").click();
    await page.getByTestId("button-confirm-dismiss").click();

    // Rows disappear from the UI…
    for (const id of ids) {
      await expect(page.getByTestId(`card-email-doc-${id}`)).toHaveCount(0);
    }
    // …and are permanently gone from the DB.
    const left = await db.query(`SELECT id FROM email_documents WHERE id = ANY($1::int[])`, [ids]);
    expect(left.rows.length).toBe(0);
  } finally {
    await context.close();
    await db.query(`DELETE FROM email_documents WHERE id = ANY($1::int[])`, [ids]).catch(() => {});
    await db.end();
  }
});
