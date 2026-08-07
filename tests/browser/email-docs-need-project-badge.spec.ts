import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the "emailed documents need a project" dashboard badge
 * (Task #313).
 *
 * After extraction, emailed documents that could not be matched to a project
 * end at extraction_status='needs_review' with project_id NULL — previously
 * visible only on the email queue page. This spec seeds one such row and
 * asserts:
 *   - the Gmail status bar on the dashboard shows the needs-project badge
 *     with the correct count;
 *   - clicking the badge deep-links to /documents?filter=needs_project and
 *     the queue is pre-filtered to the unassigned needs_review doc.
 *
 * REQUIRES the server to be booted with ENABLE_DEV_LOGIN_FOR_E2E=true.
 * All seeded rows are removed in the finally block regardless of pass/fail.
 */

const SEED_MSG_ID = "e2e-need-project-badge-msg";

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

test("dashboard badge counts unassigned needs_review email docs and deep-links to the filtered queue", async ({ page }) => {
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
  const db = new Client({ connectionString: databaseUrl! });
  await db.connect();
  try {
    await db.query(`DELETE FROM email_documents WHERE email_message_id = $1`, [SEED_MSG_ID]);
    await db.query(
      `INSERT INTO email_documents (email_message_id, email_subject, email_from, attachment_file_name, extraction_status, document_type)
       VALUES ($1, 'E2E badge devis', 'badge-e2e@example.com', 'e2e-badge-devis.pdf', 'needs_review', 'quotation')`,
      [SEED_MSG_ID],
    );

    await devLogin(page.request, "e2e@renosud.com");

    await page.goto("/");
    const badgeLink = page.getByTestId("link-email-docs-need-project");
    await expect(badgeLink).toBeVisible();
    // Count is >= 1 (the seeded row); other unassigned docs may exist.
    const badge = page.getByTestId("badge-email-docs-need-project");
    const count = Number(await badge.innerText());
    expect(count).toBeGreaterThanOrEqual(1);

    await badgeLink.click();
    await expect(page).toHaveURL(/\/documents\?filter=needs_project/);
    // The seeded unassigned needs_review doc is visible in the filtered queue.
    await expect(page.getByText("E2E badge devis")).toBeVisible();
    // The status filter reflects the deep-linked "Needs Project" mode.
    await expect(page.getByTestId("select-status-filter")).toContainText("Needs Project");
  } finally {
    await db.query(`DELETE FROM email_documents WHERE email_message_id = $1`, [SEED_MSG_ID]);
    await db.end();
  }
});
