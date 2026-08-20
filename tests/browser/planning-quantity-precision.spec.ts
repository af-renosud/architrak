import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

async function devLogin(api: APIRequestContext, email: string) {
  const response = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    response.ok(),
    `dev-login failed (${response.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

test.describe("Planning quantity precision", () => {
  test("saves and reviews a PDF-backed revision with database-formatted quantities", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-planning-quantity-${unique}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await db.connect();

    let projectId: number | null = null;
    let contractorId: number | null = null;

    try {
      const api = context.request;
      await devLogin(api, email);

      const projectResponse = await api.post("/api/projects", {
        data: {
          name: `Planning quantity project ${unique}`,
          code: `PLAN-QTY-${unique}`,
          clientName: "Planning Client",
        },
      });
      expect(projectResponse.ok()).toBe(true);
      const project = (await projectResponse.json()) as { id: number };
      projectId = project.id;

      const contractorResult = await db.query<{ id: number }>(
        `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
        [`Planning Quantity Contractor ${unique}`],
      );
      contractorId = contractorResult.rows[0].id;

      await db.query("BEGIN");
      let revisionId: number;
      try {
        const envelopeResult = await db.query<{ id: number }>(
          `INSERT INTO planning_envelopes (project_id) VALUES ($1) RETURNING id`,
          [projectId],
        );
        const revisionResult = await db.query<{ id: number }>(
          `INSERT INTO planning_revisions
             (envelope_id, contractor_id, reference, description_fr, amount_ht, amount_ttc,
              tva_rate_percent, created_by)
           VALUES ($1, $2, $3, $4, '100.00', '120.00', '20.00', $5)
           RETURNING id`,
          [
            envelopeResult.rows[0].id,
            contractorId,
            `QTY-${unique}`,
            "Imported planning works",
            email,
          ],
        );
        revisionId = revisionResult.rows[0].id;
        await db.query(
          `INSERT INTO planning_revision_lines
             (revision_id, line_number, description, quantity, unit, unit_price_ht, total_ht)
           VALUES ($1, 1, 'Imported work', '1.000', 'u', '100.00', '100.00')`,
          [revisionId],
        );
        await db.query(
          `INSERT INTO planning_revision_sources
             (revision_id, source_kind, storage_key, file_name, file_sha256, mime_type,
              file_size_bytes, parser_version, provider, model_id, raw_extraction,
              confidence, requires_verification)
           VALUES ($1, 'pdf_upload', $2, $3, $4, 'application/pdf', 1024, 'e2e', 'e2e',
                   'e2e', $5::jsonb, 100, false)`,
          [
            revisionId,
            `planning/e2e/${unique}.pdf`,
            `planning-quantity-${unique}.pdf`,
            "a".repeat(64),
            JSON.stringify({
              documentType: "quotation",
              lineItems: [{ lineNumber: 1, quantity: 1, total: 100 }],
            }),
          ],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      const page = await context.newPage();
      await page.goto(`/projets/${projectId}?tab=planning-envelope`);
      await expect(page.getByTestId(`planning-envelope-revision-${revisionId}`)).toBeVisible();

      await page.getByTestId(`planning-envelope-edit-${revisionId}`).click();
      await expect(page.getByTestId("planning-envelope-form")).toBeVisible();
      await expect(page.getByRole("spinbutton", { name: "Quantity" })).toHaveValue("1.000");
      await page.getByTestId("planning-envelope-form-scope").fill("Imported planning works checked");

      const [saveResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === "PATCH"
          && response.url().endsWith(`/api/planning-revisions/${revisionId}`),
        ),
        page.getByTestId("planning-envelope-form-submit").click(),
      ]);
      expect(saveResponse.ok()).toBe(true);
      await expect(page.getByTestId("planning-envelope-form")).toHaveCount(0);

      const persisted = await db.query<{ quantity: string; version: number }>(
        `SELECT prl.quantity::text AS quantity, pr.version
           FROM planning_revision_lines prl
           JOIN planning_revisions pr ON pr.id = prl.revision_id
          WHERE prl.revision_id = $1`,
        [revisionId],
      );
      expect(persisted.rows).toEqual([{ quantity: "1.000", version: 2 }]);

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
      await expect(page.getByTestId(`planning-envelope-revision-${revisionId}`)).toContainText("Reviewed");
    } finally {
      if (projectId != null) {
        await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
      if (contractorId != null) {
        await db.query("DELETE FROM contractors WHERE id = $1", [contractorId]);
      }
      await db.query("DELETE FROM users WHERE email = $1", [email]).catch(() => undefined);
      await context.close();
      await db.end();
    }
  });
});