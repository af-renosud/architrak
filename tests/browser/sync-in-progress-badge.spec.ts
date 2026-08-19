import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the live "Sync in progress" badge in the New Project
 * dialog (task #644).
 *
 * /api/archidoc/status exposes `syncInProgress`, derived from a
 * pg_try_advisory_lock probe of the mirror-sync lock — server truth, not
 * local button state. While the dialog is open the client polls status, so:
 *   - a sync already running when the dialog opens shows the badge
 *   - a sync that starts AFTER the dialog opened is still discovered
 *   - when the sync finishes (true -> false) the ArchiDoc project list is
 *     refetched automatically, surfacing freshly-mirrored projects without
 *     a manual reload.
 *
 * We simulate an external sync (webhook / scheduler / other tab) by holding
 * the same advisory lock from a dedicated pg session — the lock is
 * session-scoped, so it stays held until we release it or disconnect.
 *
 * Requires the dev server with ENABLE_DEV_LOGIN_FOR_E2E=true and
 * DATABASE_URL (both provided by the `Start application` workflow env).
 */

const LOCK_SQL_ACQUIRE =
  "SELECT pg_advisory_lock(hashtext('archidoc_mirror_sync'))";
const LOCK_SQL_RELEASE =
  "SELECT pg_advisory_unlock(hashtext('archidoc_mirror_sync'))";

const SEED_ID = "e2e-sync-badge-project";

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

function newDbClient() {
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
  return new Client({ connectionString: databaseUrl });
}

async function seedArchidocProject(client: Client, projectName: string) {
  await client.query(
    `INSERT INTO archidoc_projects
       (archidoc_id, project_name, code, client_name, address, status,
        clients, lot_contractors, custom_lots, is_deleted)
     VALUES ($1, $2, 'E2E-SYNCB', 'E2E Client', '1 Test Street', 'active',
             '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, false)
     ON CONFLICT (archidoc_id) DO UPDATE
       SET project_name = EXCLUDED.project_name, is_deleted = false`,
    [SEED_ID, projectName],
  );
}

async function cleanup(client: Client) {
  await client.query("DELETE FROM archidoc_projects WHERE archidoc_id = $1", [SEED_ID]);
}

test.describe("New Project dialog — live sync-in-progress badge", () => {
  test("badge shows for an already-running external sync and clears when it finishes", async ({ browser }) => {
    const locker = newDbClient();
    await locker.connect();
    const seeder = newDbClient();
    await seeder.connect();
    let lockHeld = false;
    try {
      // External sync already running BEFORE the dialog opens.
      await locker.query(LOCK_SQL_ACQUIRE);
      lockHeld = true;

      const context = await browser.newContext();
      const api = context.request;
      await devLogin(api, "e2e-sync-badge@renosud.com");
      const page = await context.newPage();
      await page.goto("/projets");
      await page.getByTestId("button-new-project").click();

      // Badge appears from server truth (no local sync was started here).
      await expect(page.getByTestId("text-archidoc-sync-in-progress")).toBeVisible({
        timeout: 15_000,
      });

      // Mirror a "new" project while the sync is running, then finish the
      // sync. The list must refresh automatically (true -> false transition
      // invalidates /api/archidoc/projects) without a manual reload.
      const name = `E2E Sync Badge ${Date.now()}`;
      await seedArchidocProject(seeder, name);
      await locker.query(LOCK_SQL_RELEASE);
      lockHeld = false;

      await expect(page.getByTestId("text-archidoc-sync-in-progress")).toBeHidden({
        timeout: 15_000,
      });
      await expect(page.getByTestId(`button-select-project-${SEED_ID}`)).toBeVisible({
        timeout: 15_000,
      });
      await context.close();
    } finally {
      if (lockHeld) await locker.query(LOCK_SQL_RELEASE).catch(() => {});
      await cleanup(seeder).catch(() => {});
      await locker.end();
      await seeder.end();
    }
  });

  test("a sync that starts AFTER the dialog is open is discovered by polling", async ({ browser }) => {
    const locker = newDbClient();
    await locker.connect();
    let lockHeld = false;
    try {
      const context = await browser.newContext();
      const api = context.request;
      await devLogin(api, "e2e-sync-badge2@renosud.com");
      const page = await context.newPage();
      await page.goto("/projets");
      await page.getByTestId("button-new-project").click();

      // No sync yet — badge must not be shown.
      await expect(page.getByTestId("text-archidoc-sync-in-progress")).toHaveCount(0);

      // External sync starts while the dialog sits open.
      await locker.query(LOCK_SQL_ACQUIRE);
      lockHeld = true;
      await expect(page.getByTestId("text-archidoc-sync-in-progress")).toBeVisible({
        timeout: 15_000,
      });

      await locker.query(LOCK_SQL_RELEASE);
      lockHeld = false;
      await expect(page.getByTestId("text-archidoc-sync-in-progress")).toBeHidden({
        timeout: 15_000,
      });
      await context.close();
    } finally {
      if (lockHeld) await locker.query(LOCK_SQL_RELEASE).catch(() => {});
      await locker.end();
    }
  });
});
