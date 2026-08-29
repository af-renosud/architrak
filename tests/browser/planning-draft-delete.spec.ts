import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

async function devLogin(api: APIRequestContext, email: string) {
  const response = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    response.ok(),
    `dev-login failed (${response.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

test.describe("Planning uploaded draft deletion", () => {
  test("deletes an accidental PDF draft and leaves the replacement upload path available", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-planning-delete-${unique}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await db.connect();

    let projectId: number | null = null;
    let uploadedRevisionId: number | null = null;
    let manualRevisionId: number | null = null;
    let activeImportJobId: number | null = null;

    try {
      const api = context.request;
      await devLogin(api, email);

      const projectResponse = await api.post("/api/projects", {
        data: {
          name: `Planning delete project ${unique}`,
          code: `PLAN-DEL-${unique.slice(0, 8)}`,
          clientName: "Planning delete client",
        },
      });
      expect(projectResponse.ok()).toBe(true);
      const project = (await projectResponse.json()) as { id: number };
      projectId = project.id;

      await db.query("BEGIN");
      try {
        const envelopeResult = await db.query<{ id: number }>(
          "INSERT INTO planning_envelopes (project_id) VALUES ($1) RETURNING id",
          [projectId],
        );
        const envelopeId = envelopeResult.rows[0].id;

        const uploadedResult = await db.query<{ id: number }>(
          `INSERT INTO planning_revisions
             (envelope_id, reference, description_fr, amount_ht, amount_ttc, created_by)
           VALUES ($1, $2, $3, '250.00', '300.00', $4)
           RETURNING id`,
          [
            envelopeId,
            `ACCIDENT-${unique.slice(0, 8)}`,
            "Accidental uploaded devis",
            email,
          ],
        );
        uploadedRevisionId = uploadedResult.rows[0].id;

        const storageKey = `/bucket/planning/e2e-delete-${unique}.pdf`;
        const fileSha256 = "c".repeat(64);
        await db.query(
          `INSERT INTO planning_revision_sources
             (revision_id, source_kind, storage_key, file_name, file_sha256,
              mime_type, file_size_bytes, parser_version, provider, model_id,
              raw_extraction, confidence, warnings)
           VALUES ($1, 'pdf_upload', $2, $3, $4, 'application/pdf', 2048,
                   'e2e-delete-v1', 'e2e', 'e2e-model', $5::jsonb, 98, '[]'::jsonb)`,
          [
            uploadedRevisionId,
            storageKey,
            `accidental-${unique}.pdf`,
            fileSha256,
            JSON.stringify({ documentType: "quotation" }),
          ],
        );
        await db.query(
          `INSERT INTO planning_revision_lines
             (revision_id, line_number, description, total_ht)
           VALUES ($1, 1, 'Accidental extracted line', '250.00')`,
          [uploadedRevisionId],
        );
        await db.query(
          `INSERT INTO planning_revision_events (revision_id, action, actor, payload)
           VALUES ($1, 'created_from_pdf', $2, '{}'::jsonb)`,
          [uploadedRevisionId, email],
        );
        const activeImportResult = await db.query<{ id: number }>(
          `INSERT INTO planning_import_jobs
             (project_id, file_name, file_sha256, mime_type, file_size_bytes, created_by)
           VALUES ($1, $2, $3, 'application/pdf', 2048, $4)
           RETURNING id`,
          [projectId, `processing-${unique}.pdf`, fileSha256, email],
        );
        activeImportJobId = activeImportResult.rows[0].id;
        const manualResult = await db.query<{ id: number }>(
          `INSERT INTO planning_revisions
             (envelope_id, reference, description_fr, amount_ht, amount_ttc, created_by)
           VALUES ($1, $2, $3, '100.00', '120.00', $4)
           RETURNING id`,
          [
            envelopeId,
            `MANUAL-${unique.slice(0, 8)}`,
            "Manual draft must remain protected",
            email,
          ],
        );
        manualRevisionId = manualResult.rows[0].id;
        await db.query(
          `INSERT INTO planning_revision_sources (revision_id, source_kind)
           VALUES ($1, 'manual')`,
          [manualRevisionId],
        );

        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      const page = await context.newPage();
      await page.goto(`/projets/${projectId}?tab=planning-envelope`);
      await expect(page.getByTestId("panel-planning-envelope")).toBeVisible();

      const uploadedCard = page.getByTestId(`planning-envelope-revision-${uploadedRevisionId}`);
      await expect(uploadedCard).toBeVisible();
      await expect(page.getByTestId(`planning-envelope-delete-${uploadedRevisionId}`)).toHaveCount(0);
      await expect(page.getByTestId(`planning-envelope-delete-${manualRevisionId}`)).toBeVisible();

      await db.query(
        `UPDATE planning_import_jobs
            SET status = 'failed',
                error_code = 'E2E_RELEASE',
                error_message = 'Release deletion in the browser test',
                completed_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [activeImportJobId],
      );
      const [refreshResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "GET" &&
            response.url().includes(`/api/projects/${projectId}/planning-envelope`),
        ),
        page.getByTestId("planning-envelope-refresh-status").click(),
      ]);
      expect(refreshResponse.ok()).toBe(true);
      await expect(page.getByTestId(`planning-envelope-delete-${uploadedRevisionId}`)).toBeVisible();

      await page.getByTestId(`planning-envelope-delete-${uploadedRevisionId}`).click();
      const dialog = page.getByTestId("planning-envelope-delete-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Delete this candidate quotation?");
      await expect(dialog).toContainText("cannot be undone");

      const [deleteResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "DELETE" &&
            response.url().includes(`/api/planning-revisions/${uploadedRevisionId}`),
        ),
        page.getByTestId("planning-envelope-delete-confirm").click(),
      ]);
      expect(deleteResponse.ok()).toBe(true);

      await expect(uploadedCard).toHaveCount(0);
      await expect(page.getByTestId("planning-envelope-delete-dialog")).toHaveCount(0);
      await expect(page.getByTestId("planning-envelope-import")).toBeVisible();
      await expect(page.getByTestId(`planning-envelope-revision-${manualRevisionId}`)).toBeVisible();

      const deletedRevision = await db.query(
        "SELECT id FROM planning_revisions WHERE id = $1",
        [uploadedRevisionId],
      );
      expect(deletedRevision.rowCount).toBe(0);

      await page.getByTestId(`planning-envelope-delete-${manualRevisionId}`).click();
      await expect(page.getByTestId("planning-envelope-delete-dialog")).toContainText("Delete this candidate quotation?");
      const [manualDeleteResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "DELETE" &&
            response.url().includes(`/api/planning-revisions/${manualRevisionId}`),
        ),
        page.getByTestId("planning-envelope-delete-confirm").click(),
      ]);
      expect(manualDeleteResponse.ok()).toBe(true);
      await expect(page.getByTestId(`planning-envelope-revision-${manualRevisionId}`)).toHaveCount(0);
    } finally {
      if (projectId != null) {
        await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
      await db.query("DELETE FROM users WHERE email = $1", [email]).catch(() => undefined);
      await context.close();
      await db.end();
    }
  });
});