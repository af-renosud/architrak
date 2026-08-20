import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

async function devLogin(api: APIRequestContext, email: string) {
  const response = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    response.ok(),
    `dev-login failed (${response.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

test.describe("Planning ArchiDoc supplier selection", () => {
  test("selects an active supplier and reviews the draft", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-planning-supplier-${unique}@local.test`;
    const supplierName = `Planning Supplier ${unique}`;
    const db = new Client({ connectionString: databaseUrl! });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await db.connect();

    let projectId: number | null = null;
    let supplierId: number | null = null;

    try {
      const api = context.request;
      await devLogin(api, email);

      const projectResponse = await api.post("/api/projects", {
        data: {
          name: `Planning supplier project ${unique}`,
          code: `PLAN-SUP-${unique}`,
          clientName: "Planning Client",
        },
      });
      expect(projectResponse.ok()).toBe(true);
      const project = (await projectResponse.json()) as { id: number };
      projectId = project.id;

      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO contractors
           (name, archidoc_id, archidoc_partner_type)
         VALUES ($1, $2, 'supplier')
         RETURNING id`,
        [supplierName, `e2e-supplier-${unique}`],
      );
      supplierId = rows[0].id;

      const page = await context.newPage();
      await page.goto(`/projets/${projectId}?tab=planning-envelope`);
      await expect(page.getByTestId("panel-planning-envelope")).toBeVisible();

      await page.getByTestId("planning-envelope-new").click();
      await expect(page.getByTestId("planning-envelope-form")).toBeVisible();

      await page.getByTestId("planning-envelope-form-contractor").click();
      const supplierOption = page.getByRole("option", {
        name: `${supplierName} — Supplier`,
      });
      await expect(supplierOption).toBeVisible();
      await supplierOption.click();

      await page.getByTestId("planning-envelope-form-reference").fill(`SUP-${unique}`);
      await page.getByTestId("planning-envelope-form-scope").fill("Planning materials allowance");
      await page.getByTestId("planning-envelope-form-ht").fill("1000");
      await page.getByTestId("planning-envelope-form-ttc").fill("1200");
      const [createResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === "POST"
          && response.url().endsWith(`/api/projects/${projectId}/planning-envelope/revisions`),
        ),
        page.getByTestId("planning-envelope-form-submit").click(),
      ]);
      expect(createResponse.ok()).toBe(true);
      await expect(page.getByTestId("planning-envelope-form")).toHaveCount(0);

      const summary = await api.get(`/api/projects/${projectId}/planning-envelope`);
      expect(summary.ok()).toBe(true);
      const body = (await summary.json()) as {
        revisions: Array<{
          revision: { id: number; contractorId: number; status: string };
          contractorName: string | null;
        }>;
      };
      expect(body.revisions).toHaveLength(1);
      expect(body.revisions[0]).toMatchObject({
        revision: {
          contractorId: supplierId,
          status: "draft",
        },
        contractorName: supplierName,
      });

      const revisionId = body.revisions[0].revision.id;
      await page.getByTestId(`planning-envelope-review-${revisionId}`).click();
      await expect(page.getByTestId("planning-envelope-review-dialog")).toBeVisible();
      const [reviewResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === "POST"
          && response.url().endsWith(`/api/planning-revisions/${revisionId}/review`),
        ),
        page.getByTestId("planning-envelope-review-confirm").click(),
      ]);
      expect(reviewResponse.ok()).toBe(true);

      await expect(page.getByTestId(`planning-envelope-revision-${revisionId}`)).toContainText(
        "Reviewed",
      );
    } finally {
      if (projectId != null) {
        await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
      if (supplierId != null) {
        await db.query("DELETE FROM contractors WHERE id = $1", [supplierId]);
      }
      await db.query("DELETE FROM users WHERE email = $1", [email]).catch(() => undefined);
      await context.close();
      await db.end();
    }
  });
});