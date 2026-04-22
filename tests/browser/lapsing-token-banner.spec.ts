import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { createHash, randomBytes } from "node:crypto";

/**
 * E2E coverage for the per-devis lapsing-link warning banner (task #95).
 *
 * Seeds a project + contractor + devis + an active devis_check_tokens row
 * with `expires_at` set 3 days in the future, then asserts:
 *   1. The banner renders above the checks panel with the FR copy
 *      ("Le lien partagé avec l'entreprise expire dans 3 jours.").
 *   2. Clicking "Prolonger de 90 jours" calls the existing
 *      /api/devis/:devisId/check-token/extend route, surfaces the FR
 *      success toast, and the banner disappears on the refreshed render
 *      (since the refreshed expiry is 90 days out, well outside the
 *      7-day threshold).
 *
 * Requires: ENABLE_DEV_LOGIN_FOR_E2E=true (so dev-login works) and
 * DATABASE_URL set (to seed the active token directly — there is no
 * public API to force a 3-day-in-the-future expiry).
 */

const SEED_PREFIX = "e2e-lapsing-banner-";

interface Seeded {
  rawToken: string;
  tokenId: number;
  devisId: number;
  contractorId: number;
  projectId: number;
}

async function devLogin(api: { post: (url: string, opts: { data: unknown }) => Promise<{ ok: () => boolean; status: () => number }> }, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`).toBe(true);
}

async function seedActiveToken(db: Client, uniq: string): Promise<Seeded> {
  const projectRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${SEED_PREFIX}project-${uniq}`, `${SEED_PREFIX}${uniq}`, "Test Client"],
  );
  const projectId = projectRes.rows[0].id;

  const contractorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, email)
     VALUES ($1, $2) RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`, `${SEED_PREFIX}${uniq}@local.test`],
  );
  const contractorId = contractorRes.rows[0].id;

  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D-${uniq}`, "Devis lapsing-banner test", "100.00", "120.00"],
  );
  const devisId = devisRes.rows[0].id;

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  // 3 days in the future = within the 7-day threshold, so the banner must
  // render and report "3 jours".
  const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const tokenRes = await db.query<{ id: number }>(
    `INSERT INTO devis_check_tokens
       (devis_id, token_hash, contractor_id, contractor_email, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [devisId, tokenHash, contractorId, `${SEED_PREFIX}${uniq}@local.test`, future.toISOString()],
  );

  return { rawToken, tokenId: tokenRes.rows[0].id, devisId, contractorId, projectId };
}

async function cleanup(db: Client, s: Seeded | null) {
  if (!s) return;
  // Best-effort cleanup. The seed only inserts tokens/devis/project/contractor;
  // any related child rows (checks, messages) created at runtime by the API
  // are wiped via cascade or simply left to test isolation. We swallow
  // individual failures so a missing optional table never masks the real
  // assertion failure surfaced by the test body.
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM devis_check_tokens WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[lapsing-banner cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Devis — lapsing portal-link banner (task #95)", () => {
  test("shows FR copy with X jours, extend click hides the banner", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-lapsing-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext();
    let seeded: Seeded | null = null;
    try {
      seeded = await seedActiveToken(db, uniq);
      await devLogin(context.request, email);

      const page = await context.newPage();
      await page.goto(`/projets/${seeded.projectId}`);
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${seeded.devisId}`).click();

      // Banner renders with FR plural copy ("3 jours").
      const banner = page.getByTestId(`banner-token-lapsing-${seeded.devisId}`);
      await expect(banner).toBeVisible();
      const text = page.getByTestId(`text-token-lapsing-${seeded.devisId}`);
      await expect(text).toHaveText(
        "Le lien partagé avec l'entreprise expire dans 3 jours.",
      );

      // Stub the extend endpoint and the follow-up token refetch so the
      // test verifies the UI flow hermetically. The real backend call is
      // covered by the existing /extend route + audit infra; what we need
      // to assert here is that clicking the button (a) hits the right URL
      // and (b) causes the banner to disappear once the refreshed token
      // (90 days out) is loaded into the React Query cache.
      const extendUrl = `**/api/devis/${seeded.devisId}/check-token/extend`;
      const tokenUrl = `**/api/devis/${seeded.devisId}/check-token`;
      const ninetyDaysOut = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      const refreshedTokenBody = {
        token: {
          id: seeded.tokenId,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          expiresAt: ninetyDaysOut,
          revokedAt: null,
        },
      };
      let extendCalled = false;
      await page.route(extendUrl, async (route) => {
        if (route.request().method() === "POST") {
          extendCalled = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(refreshedTokenBody),
          });
        } else {
          await route.continue();
        }
      });
      // Subsequent GET (after invalidate) returns the refreshed token so
      // the banner recomputes from a 90-day expiry and hides itself.
      await page.route(tokenUrl, async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(refreshedTokenBody),
          });
        } else {
          await route.continue();
        }
      });

      const extendBtn = page.getByTestId(`button-extend-lapsing-token-${seeded.devisId}`);
      await expect(extendBtn).toHaveText("Prolonger de 90 jours");
      await extendBtn.click();

      // FR success toast appears.
      await expect(
        page.getByText("Lien prolongé de 90 jours", { exact: true }),
      ).toBeVisible({ timeout: 5_000 });

      // Banner recalculates and disappears (refreshed expiry is 90 days
      // out, well outside the 7-day threshold).
      await expect(banner).toBeHidden({ timeout: 5_000 });
      expect(extendCalled, "POST /check-token/extend was not invoked").toBe(true);
    } finally {
      try {
        await cleanup(db, seeded);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
