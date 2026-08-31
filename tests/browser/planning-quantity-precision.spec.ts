import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { deleteDocument } from "../../server/storage/object-storage";

const TINY_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000052 00000 n
0000000101 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
164
%%EOF`,
  "latin1",
);

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
    let floorPlanStorageKey: string | null = null;

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
      const floorPlanUpload = await api.post(`/api/projects/${projectId}/documents/upload`, {
        multipart: {
          file: {
            name: `ground-floor-${unique}.pdf`,
            mimeType: "application/pdf",
            buffer: TINY_PDF,
          },
          documentType: "plan",
          uploadedBy: "e2e",
        },
      });
      expect(floorPlanUpload.ok()).toBe(true);
      const floorPlanDocument = (await floorPlanUpload.json()) as {
        id: number;
        storageKey: string;
      };
      floorPlanStorageKey = floorPlanDocument.storageKey;

      const floorPlanPreview = await api.get(
        `/api/documents/${floorPlanDocument.id}/preview`,
      );
      expect(floorPlanPreview.ok()).toBe(true);
      expect(floorPlanPreview.headers()["content-type"]).toContain("application/pdf");
      expect(floorPlanPreview.headers()["content-disposition"]).toMatch(/^inline;/);
      expect((await floorPlanPreview.body()).subarray(0, 5).toString()).toBe("%PDF-");

      const floorPlanDownload = await api.get(
        `/api/documents/${floorPlanDocument.id}/download`,
      );
      expect(floorPlanDownload.ok()).toBe(true);
      expect(floorPlanDownload.headers()["content-disposition"]).toMatch(/^attachment;/);

      const contractorResult = await db.query<{ id: number }>(
        `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
        [`Planning Quantity Contractor ${unique}`],
      );
      contractorId = contractorResult.rows[0].id;

      await db.query("BEGIN");
      let revisionId: number;
      let secondRevisionId: number;
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
        const secondRevisionResult = await db.query<{ id: number }>(
          `INSERT INTO planning_revisions
             (envelope_id, contractor_id, reference, description_fr, amount_ht, amount_ttc,
              tva_rate_percent, created_by)
           VALUES ($1, $2, $3, 'Alternative imported planning works', '80.00', '96.00', '20.00', $4)
           RETURNING id`,
          [
            envelopeResult.rows[0].id,
            contractorId,
            `QTY-ALT-${unique}`,
            email,
          ],
        );
        secondRevisionId = secondRevisionResult.rows[0].id;
        await db.query(
          `INSERT INTO planning_revision_lines
             (revision_id, line_number, description, quantity, unit, unit_price_ht, total_ht)
           VALUES
             ($1, 1, 'Imported work', '1.000', 'u', '100.00', '100.00'),
             ($2, 1, 'Alternative work', '1.000', 'u', '80.00', '80.00')`,
          [revisionId, secondRevisionId],
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
      const pdfResponse = {
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF-1.4\n% planning popout browser fixture\n",
      };
      await page.route(`**/api/planning-revisions/${revisionId}/pdf*`, (route) =>
        route.fulfill({
          ...pdfResponse,
          headers: {
            ...pdfResponse.headers,
            "content-disposition": "inline; filename=planning.pdf",
          },
          body: route.request().method() === "HEAD" ? "" : pdfResponse.body,
        }),
      );
      await page.goto(`/projets/${projectId}?tab=planning-envelope`);
      await expect(page.getByTestId(`planning-envelope-revision-${revisionId}`)).toBeVisible();
      await expect(page.getByTestId(`planning-envelope-pdf-${revisionId}`)).toHaveAttribute(
        "href",
        `/api/planning-revisions/${revisionId}/pdf?download=1`,
      );
      await expect(page.getByTestId(`planning-envelope-pdf-${revisionId}`)).toHaveAttribute("download", "");
      await expect(page.getByTestId(`planning-envelope-view-pdf-${revisionId}`)).toBeVisible();

      await page.getByTestId(`planning-envelope-review-${revisionId}`).click();
      await expect(page.getByTestId("planning-envelope-review-inline")).toBeVisible();
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
      await expect(page.getByTestId("planning-envelope-review-inline")).toHaveCount(0);
      await expect(page.getByTestId(`planning-envelope-review-${revisionId}`)).toHaveAttribute("aria-expanded", "false");

      const persisted = await db.query<{ quantity: string; version: number }>(
        `SELECT prl.quantity::text AS quantity, pr.version
           FROM planning_revision_lines prl
           JOIN planning_revisions pr ON pr.id = prl.revision_id
          WHERE prl.revision_id = $1`,
        [revisionId],
      );
      expect(persisted.rows).toEqual([{ quantity: "1.000", version: 2 }]);

      await page.getByTestId(`planning-envelope-review-${revisionId}`).click();
      await expect(page.getByTestId("planning-envelope-review-inline")).toBeVisible();
      await expect(page.getByTestId(`planning-envelope-review-${revisionId}`)).toHaveAttribute("aria-expanded", "true");
      await page.getByTestId(`planning-envelope-view-pdf-${revisionId}`).click();
      const sourcePdf = page.getByTestId(`dialog-pdf-popout-planning-${revisionId}`);
      await expect(sourcePdf).toBeVisible();
      await expect(page.getByTestId("planning-envelope-review-inline")).toBeVisible();
      await page.getByTestId(`button-pdf-popout-minimize-planning-${revisionId}`).click();
      await expect(sourcePdf).toHaveAttribute("data-minimized", "true");
      await page.evaluate(
        ({ key, value }) => window.sessionStorage.setItem(key, value),
        {
          key: `architrak.floorPlanPopout.frame.floor-plan-${projectId}`,
          value: JSON.stringify({
            x: 9_999,
            y: 9_999,
            w: 9_999,
            h: 9_999,
            minimized: false,
          }),
        },
      );
      await page.getByTestId(`planning-envelope-open-floor-plan-${projectId}`).click();
      const floorPlan = page.getByTestId(`dialog-pdf-popout-floor-plan-${projectId}`);
      await expect(floorPlan).toBeVisible();
      await expect(floorPlan).toHaveAttribute("aria-label", /Floor plan viewer/);
      await expect(page.getByTestId(`pdf-popout-iframe-floor-plan-${projectId}`)).toBeVisible();
      const recoveredFrame = await floorPlan.boundingBox();
      expect(recoveredFrame).not.toBeNull();
      expect(recoveredFrame!.x).toBeGreaterThanOrEqual(0);
      expect(recoveredFrame!.y).toBeGreaterThanOrEqual(0);
      expect(recoveredFrame!.x + recoveredFrame!.width).toBeLessThanOrEqual(1440);
      expect(recoveredFrame!.y + recoveredFrame!.height).toBeLessThanOrEqual(1000);
      await expect(page.getByTestId("planning-envelope-review-inline")).toBeVisible();
      await page.getByTestId(`button-pdf-popout-minimize-floor-plan-${projectId}`).click();
      await expect(floorPlan).toHaveAttribute("data-minimized", "true");
      await page.getByTestId(`button-pdf-popout-close-floor-plan-${projectId}`).click();
      await page.getByTestId(`planning-envelope-open-floor-plan-${projectId}`).click();
      await expect(floorPlan).toHaveAttribute("data-minimized", "true");
      await page.getByTestId(`button-pdf-popout-minimize-floor-plan-${projectId}`).click();
      await expect(floorPlan).toHaveAttribute("data-minimized", "false");
      await page.getByTestId(`button-pdf-popout-minimize-floor-plan-${projectId}`).click();
      await expect(floorPlan).toHaveAttribute("data-minimized", "true");
      await page.getByTestId(`planning-envelope-review-${secondRevisionId}`).click();
      await expect(page.getByTestId("planning-envelope-review-inline")).toContainText(
        `QTY-ALT-${unique}`,
      );
      await expect(floorPlan).toBeVisible();
      await page.getByTestId(`planning-envelope-review-${revisionId}`).click();
      await expect(page.getByTestId("planning-envelope-review-inline")).toContainText(
        `QTY-${unique}`,
      );
      await expect(floorPlan).toBeVisible();
      await page.getByTestId(`button-pdf-popout-close-planning-${revisionId}`).click();
      const [reviewResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === "POST"
          && response.url().endsWith(`/api/planning-revisions/${revisionId}/review`),
        ),
        page.getByTestId("planning-envelope-review-confirm").click(),
      ]);
      expect(reviewResponse.ok()).toBe(true);
      await expect(page.getByTestId("planning-envelope-review-inline")).toHaveCount(0);
      await expect(page.getByTestId(`planning-envelope-revision-${revisionId}`)).toContainText("Reviewed");

      await db.query("UPDATE projects SET archived_at = NOW() WHERE id = $1", [projectId]);
      await page.reload();
      await expect(page.getByTestId("planning-envelope-archived-banner")).toBeVisible();
      await expect(page.getByTestId(`planning-envelope-open-floor-plan-${projectId}`)).toBeEnabled();
      await expect(page.getByTestId("planning-envelope-import")).toBeDisabled();
      await expect(page.getByTestId("planning-envelope-new")).toBeDisabled();
      await page.getByTestId(`planning-envelope-open-floor-plan-${projectId}`).click();
      await expect(floorPlan).toBeVisible();
    } finally {
      if (projectId != null) {
        await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
      if (contractorId != null) {
        await db.query("DELETE FROM contractors WHERE id = $1", [contractorId]);
      }
      if (floorPlanStorageKey) {
        await deleteDocument(floorPlanStorageKey).catch(() => undefined);
      }
      await db.query("DELETE FROM users WHERE email = $1", [email]).catch(() => undefined);
      await context.close();
      await db.end();
    }
  });
});