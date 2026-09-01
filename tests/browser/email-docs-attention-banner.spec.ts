import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()})`).toBe(true);
}

test("pending-review banner reveals every document needing attention in one click", async ({ browser }) => {
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ids: Record<string, number> = {};
  const uniq = Date.now().toString(36);

  try {
    for (const status of ["pending", "needs_review", "completed"]) {
      const result = await db.query<{ id: number }>(
        `INSERT INTO email_documents
           (email_message_id, email_from, email_subject, attachment_file_name,
            document_type, extraction_status, updated_at)
         VALUES ($1, 'attention-e2e@test.local', $2, $3, 'invoice', $4, NOW())
         RETURNING id`,
        [`attention-e2e-${uniq}-${status}`, `Attention E2E ${status}`, `attention-${status}-${uniq}.pdf`, status],
      );
      ids[status] = result.rows[0].id;
    }

    await devLogin(context.request, `attention-e2e-${uniq}@local.test`);
    const page = await context.newPage();
    await page.goto("/documents?filter=needs_project");

    await expect(page.getByTestId(`card-email-doc-${ids.pending}`)).toHaveCount(0);
    await expect(page.getByTestId("button-show-pending-documents")).toContainText("Click to view");

    await page.getByTestId("input-search-documents").fill("no matching document");
    await page.getByTestId("button-show-pending-documents").click();

    await expect(page).toHaveURL(/filter=needs_attention/);
    await expect(page.getByTestId("input-search-documents")).toHaveValue("");
    await expect(page.getByTestId(`card-email-doc-${ids.pending}`)).toBeVisible();
    await expect(page.getByTestId(`card-email-doc-${ids.needs_review}`)).toBeVisible();
    await expect(page.getByTestId(`card-email-doc-${ids.completed}`)).toHaveCount(0);
    await expect(page.getByTestId("select-status-filter")).toContainText("Needs Attention");
    await expect(page.getByTestId("select-type-filter")).toContainText("All Types");
  } finally {
    await context.close();
    const seededIds = Object.values(ids);
    if (seededIds.length > 0) {
      await db.query(`DELETE FROM email_documents WHERE id = ANY($1::int[])`, [seededIds]).catch(() => {});
    }
    await db.end();
  }
});