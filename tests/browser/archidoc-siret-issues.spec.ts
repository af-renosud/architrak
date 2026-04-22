import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the ArchiDoc SIRET issues badge + dialog on the Projects
 * page (task #77).
 *
 * Requires the dev server with NODE_ENV=development AND
 * ENABLE_DEV_LOGIN_FOR_E2E=true so `POST /api/auth/dev-login` is registered.
 *
 * Covers:
 *   - Empty state: no rows in `archidoc_siret_issues` -> the amber badge is
 *     not rendered on /projets.
 *   - Seeded state: two rows seeded via SQL -> badge renders with the correct
 *     count, opens the dialog, and each row shows the contractor name, the
 *     ArchiDoc ID, and the raw (malformed) SIRET.
 *
 * The table is seeded directly via `pg` because there is no public API for
 * inserting SIRET issues — they are produced internally by the ArchiDoc sync.
 */

const SEED_PREFIX = "e2e-siret-issue-";

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

interface SeedRow {
  archidocId: string;
  name: string;
  rawSiret: string;
}

async function clearSeededIssues(client: Client) {
  await client.query(
    "DELETE FROM archidoc_siret_issues WHERE archidoc_id LIKE $1",
    [`${SEED_PREFIX}%`],
  );
}

async function insertIssues(client: Client, rows: SeedRow[]) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO archidoc_siret_issues (archidoc_id, name, raw_siret)
       VALUES ($1, $2, $3)
       ON CONFLICT (archidoc_id) DO UPDATE
         SET name = EXCLUDED.name,
             raw_siret = EXCLUDED.raw_siret,
             last_seen_at = CURRENT_TIMESTAMP`,
      [row.archidocId, row.name, row.rawSiret],
    );
  }
}

test.describe("Projects — ArchiDoc SIRET issues badge & dialog", () => {
  test("empty state hides the badge; seeded rows render in the dialog", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-siret-issues-${uniq}@local.test`;

    const seeds: SeedRow[] = [
      {
        archidocId: `${SEED_PREFIX}${uniq}-a`,
        name: `Acme Maçonnerie ${uniq}`,
        rawSiret: "not-a-siret",
      },
      {
        archidocId: `${SEED_PREFIX}${uniq}-b`,
        name: `Beta Plomberie ${uniq}`,
        rawSiret: "1234567890",
      },
    ];

    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext();
    try {
      // Make this test hermetic relative to other rows already present in
      // the shared dev DB: scope all assertions to a baseline count and
      // only ever insert/delete rows we own (prefix `e2e-siret-issue-`).
      await clearSeededIssues(db);
      const baselineRow = (
        await db.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM archidoc_siret_issues",
        )
      ).rows[0];
      const baselineCount = Number(baselineRow.count);

      await devLogin(context.request, email);

      // -------- Empty / baseline state --------
      const page = await context.newPage();
      await page.goto("/projets");
      // Wait for the ArchiDoc status pill so the status query has resolved
      // before we make any badge assertion.
      await expect(page.getByTestId("archidoc-status")).toBeVisible();

      if (baselineCount === 0) {
        // True empty-state assertion: badge button is not rendered at all.
        await expect(page.getByTestId("button-archidoc-siret-issues")).toHaveCount(0);
      } else {
        // The shared DB already has unrelated SIRET issues; verify the
        // badge reflects the existing baseline so the increment-by-2
        // assertion below is still meaningful.
        await expect(page.getByTestId("text-archidoc-siret-issue-count")).toHaveText(
          new RegExp(`^\\s*${baselineCount}\\s+SIRET\\s+(issue|issues)\\s*$`),
        );
      }

      // -------- Seeded state --------
      await insertIssues(db, seeds);
      const expectedCount = baselineCount + seeds.length;

      // Re-fetch /api/archidoc/status by reloading the page.
      await page.reload();
      await expect(page.getByTestId("archidoc-status")).toBeVisible();

      const badge = page.getByTestId("button-archidoc-siret-issues");
      await expect(badge).toBeVisible();
      await expect(page.getByTestId("text-archidoc-siret-issue-count")).toHaveText(
        new RegExp(`^\\s*${expectedCount}\\s+SIRET\\s+(issue|issues)\\s*$`),
      );

      await badge.click();

      const dialog = page.getByTestId("dialog-archidoc-siret-issues");
      await expect(dialog).toBeVisible();

      for (const seed of seeds) {
        const row = page.getByTestId(`row-siret-issue-${seed.archidocId}`);
        await expect(row).toBeVisible();
        await expect(
          page.getByTestId(`text-siret-issue-name-${seed.archidocId}`),
        ).toHaveText(seed.name);
        await expect(
          page.getByTestId(`text-siret-issue-archidoc-id-${seed.archidocId}`),
        ).toHaveText(`ArchiDoc ID: ${seed.archidocId}`);
        await expect(
          page.getByTestId(`text-siret-issue-raw-${seed.archidocId}`),
        ).toHaveText(seed.rawSiret);
      }
    } finally {
      try {
        await clearSeededIssues(db);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
