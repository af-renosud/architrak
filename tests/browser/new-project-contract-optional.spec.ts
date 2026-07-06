import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the "New Project" dialog's optional-design-contract
 * branching (task #249).
 *
 * The dialog used to force a signed design contract before a project could be
 * created. It now branches:
 *   - WITH a confirmed contract  -> POST /api/archidoc/track-with-contract/:id
 *   - WITHOUT a contract         -> POST /api/archidoc/track/:id (fee options)
 *
 * This regression can silently come back (someone re-adds the disabled-button
 * gate, or the no-contract path drops the fee options), so we lock in BOTH
 * flows here.
 *
 * Requires the dev server with NODE_ENV=development AND
 * ENABLE_DEV_LOGIN_FOR_E2E=true so `POST /api/auth/dev-login` is registered
 * (both are set by the `Start application` workflow).
 *
 * ArchiDoc mirror projects are seeded directly via `pg` because projects only
 * enter the system via ArchiDoc sync — there is no manual-create API. Each
 * seed uses empty lotContractors/customLots so trackProject creates zero
 * contractors and zero lots, keeping cleanup a single DELETE.
 */

const SEED_PREFIX = "e2e-new-project-";

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function seedArchidocProject(
  client: Client,
  archidocId: string,
  projectName: string,
) {
  await client.query(
    `INSERT INTO archidoc_projects
       (archidoc_id, project_name, code, client_name, address, status,
        clients, lot_contractors, custom_lots, is_deleted)
     VALUES ($1, $2, $3, $4, $5, 'active', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, false)
     ON CONFLICT (archidoc_id) DO UPDATE
       SET project_name = EXCLUDED.project_name,
           is_deleted = false`,
    [archidocId, projectName, `E2E-${archidocId.slice(-6)}`, "E2E Client", "1 Test Street"],
  );
}

async function cleanup(client: Client, archidocId: string) {
  await client.query("DELETE FROM projects WHERE archidoc_id = $1", [archidocId]);
  await client.query("DELETE FROM archidoc_projects WHERE archidoc_id = $1", [archidocId]);
}

test.describe("New Project — design contract is optional", () => {
  test("creates a project WITHOUT a contract (button enabled, fee options sent via plain track)", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const archidocId = `${SEED_PREFIX}${uniq}-nocontract`;
    const projectName = `E2E No-Contract Project ${uniq}`;
    const email = `e2e-new-project-${uniq}@local.test`;
    const feePercentage = "12.5";

    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    const context = await browser.newContext();

    try {
      await seedArchidocProject(db, archidocId, projectName);
      await devLogin(context.request, email);

      const page = await context.newPage();
      await page.goto("/projets");
      await expect(page.getByTestId("archidoc-status")).toBeVisible();

      await page.getByTestId("button-new-project").click();

      // The seeded ArchiDoc project shows up in the picker.
      const selectBtn = page.getByTestId(`button-select-project-${archidocId}`);
      await expect(selectBtn).toBeVisible();
      await selectBtn.click();

      // Regression guard: the Create button must be enabled as soon as a
      // project is selected — NO design-contract gate.
      const createBtn = page.getByTestId("button-submit-project");
      await expect(createBtn).toBeVisible();
      await expect(createBtn).toBeEnabled();

      // No contract is confirmed.
      await expect(page.getByTestId("design-contract-confirmed")).toHaveCount(0);

      // Set a fee percentage so we can prove the plain-track path forwards it.
      await page.getByTestId("input-fee-percentage").fill(feePercentage);

      await createBtn.click();

      // Success toast + dialog closes.
      await expect(page.getByText("Project tracked", { exact: true })).toBeVisible();

      // The project was really imported: it exists in the DB with the fee
      // percentage we entered, and its card renders in the list.
      const row = await db.query<{ id: number; fee_percentage: string | null }>(
        "SELECT id, fee_percentage FROM projects WHERE archidoc_id = $1",
        [archidocId],
      );
      expect(row.rowCount, "project should be created in the DB").toBe(1);
      expect(Number(row.rows[0].fee_percentage)).toBeCloseTo(Number(feePercentage), 2);

      await expect(
        page.getByTestId(`card-project-${row.rows[0].id}`),
      ).toBeVisible();
    } finally {
      try {
        await cleanup(db, archidocId);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });

  test("creates a project WITH a confirmed contract (contract-carrying track path)", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const archidocId = `${SEED_PREFIX}${uniq}-withcontract`;
    const projectName = `E2E With-Contract Project ${uniq}`;
    const email = `e2e-new-project-${uniq}@local.test`;

    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    const context = await browser.newContext();

    try {
      await seedArchidocProject(db, archidocId, projectName);
      await devLogin(context.request, email);

      const page = await context.newPage();

      // The AI extraction (Gemini) is non-deterministic, so we stub the
      // /preview endpoint with a canned, schedule-valid extraction. We also
      // stub the contract-carrying track endpoint so we can assert the FE
      // routes here (and carries the confirmed contract) without depending on
      // real object-storage staging.
      const stagingKey = `design-contracts/staging/u0/${uniq}_contract.pdf`;
      await page.route("**/api/design-contracts/preview", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            stagingKey,
            originalFilename: "contract.pdf",
            extracted: {
              documentType: "design_contract",
              totalHt: null,
              totalTva: null,
              totalTtc: 1000,
              tvaRate: null,
              conceptionAmountHt: null,
              planningAmountHt: null,
              contractDate: null,
              contractReference: null,
              clientName: null,
              architectName: null,
              projectAddress: null,
              milestones: [
                {
                  sequence: 1,
                  labelFr: "Acompte",
                  labelEn: null,
                  percentage: 100,
                  amountTtc: 1000,
                  triggerEvent: "manual",
                },
              ],
              confidence: {},
              warnings: [],
            },
          }),
        });
      });

      let trackWithContractBody: unknown = null;
      let plainTrackCalled = false;
      await page.route("**/api/archidoc/track-with-contract/**", async (route) => {
        trackWithContractBody = route.request().postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            message: "Project tracked and design contract saved",
            projectId: 999999,
            contractorsCreated: 0,
            lotsCreated: 0,
            contractId: 12345,
          }),
        });
      });
      await page.route("**/api/archidoc/track/**", async (route) => {
        plainTrackCalled = true;
        await route.abort();
      });

      await page.goto("/projets");
      await expect(page.getByTestId("archidoc-status")).toBeVisible();

      await page.getByTestId("button-new-project").click();
      await page.getByTestId(`button-select-project-${archidocId}`).click();

      const createBtn = page.getByTestId("button-submit-project");
      await expect(createBtn).toBeEnabled();

      // Upload the (stubbed) design contract PDF and confirm the extraction.
      await page.getByTestId("input-design-contract-file").setInputFiles({
        name: "contract.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4 e2e"),
      });

      await expect(page.getByTestId("dialog-design-contract-review")).toBeVisible();
      const confirmBtn = page.getByTestId("button-confirm-design-contract");
      await expect(confirmBtn).toBeEnabled();
      await confirmBtn.click();

      // The confirmed contract badge appears in the New Project dialog.
      await expect(page.getByTestId("design-contract-confirmed")).toBeVisible();

      await createBtn.click();

      await expect(page.getByText("Project tracked", { exact: true })).toBeVisible();

      // The FE used the contract-carrying path and sent the confirmed contract.
      expect(plainTrackCalled, "plain track path must NOT be used when a contract is confirmed").toBe(false);
      expect(trackWithContractBody, "track-with-contract must receive a body").toBeTruthy();
      const body = trackWithContractBody as {
        trackOptions?: Record<string, unknown>;
        designContract?: { stagingKey?: string; milestones?: unknown[] };
      };
      expect(body.designContract?.stagingKey).toBe(stagingKey);
      expect(Array.isArray(body.designContract?.milestones)).toBe(true);
      expect(body.trackOptions).toBeTruthy();
    } finally {
      try {
        await cleanup(db, archidocId);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
