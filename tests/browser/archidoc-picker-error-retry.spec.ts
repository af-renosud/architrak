import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * E2E coverage for the New Project dialog's ArchiDoc picker error/retry
 * states and the honest sync toasts (task #643).
 *
 * The picker used to show an endless skeleton when GET /api/archidoc/projects
 * failed, and the sync button always toasted "Sync complete". Both regressions
 * are locked in here:
 *   - a failing list request renders `archidoc-list-error` with a Retry
 *     button that refetches and renders the list on success;
 *   - POST /api/archidoc/sync with `failures` toasts "Sync finished with
 *     errors", and `alreadyRunning: true` toasts "Sync already in progress".
 *
 * All ArchiDoc responses are mocked via route interception — no DB seeding,
 * no dependency on the real ArchiDoc backend being reachable.
 *
 * Requires the dev server with NODE_ENV=development AND
 * ENABLE_DEV_LOGIN_FOR_E2E=true so `POST /api/auth/dev-login` is registered
 * (both are set by the `Start application` workflow).
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

function uniqSuffix() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const FAKE_PROJECT = (uniq: string) => ({
  archidocId: `e2e-picker-${uniq}`,
  projectName: `E2E Picker Project ${uniq}`,
  code: "E2E-PICK",
  clientName: "E2E Client",
  address: "1 Test Street",
  status: "active",
  clients: [],
  lotContractors: [],
  customLots: [],
  isDeleted: false,
  isTracked: false,
});

test.describe("New Project dialog — ArchiDoc picker error/retry & sync toasts", () => {
  test("failing list shows error state; Retry refetches and renders the list", async ({ browser }) => {
    const uniq = uniqSuffix();
    const context = await browser.newContext();

    try {
      await devLogin(context.request, `e2e-picker-error-${uniq}@local.test`);
      const page = await context.newPage();

      // Fail the list until Retry is clicked. The query has `retry: 1`, so
      // the initial load consumes 2 failing requests before surfacing the
      // error state; every request after the Retry click succeeds.
      let listCalls = 0;
      let retryClicked = false;
      await page.route("**/api/archidoc/projects", async (route) => {
        listCalls++;
        if (!retryClicked) {
          await route.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ error: "ArchiDoc unreachable (e2e)" }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([FAKE_PROJECT(uniq)]),
          });
        }
      });

      await page.goto("/projets");
      await page.getByTestId("button-new-project").click();

      // Error state instead of an endless skeleton.
      const errorState = page.getByTestId("archidoc-list-error");
      await expect(errorState).toBeVisible();
      expect(listCalls, "initial load + 1 retry from react-query").toBeGreaterThanOrEqual(1);

      // Retry refetches and renders the (now-successful) list.
      const callsBeforeRetry = listCalls;
      retryClicked = true;
      await page.getByTestId("button-retry-archidoc-list").click();

      const selectBtn = page.getByTestId(`button-select-project-e2e-picker-${uniq}`);
      await expect(selectBtn).toBeVisible();
      await expect(errorState).toHaveCount(0);
      expect(listCalls, "Retry must issue a new request").toBeGreaterThan(callsBeforeRetry);
    } finally {
      await context.close();
    }
  });

  test("sync with failures toasts 'Sync finished with errors'", async ({ browser }) => {
    const uniq = uniqSuffix();
    const context = await browser.newContext();

    try {
      await devLogin(context.request, `e2e-picker-syncfail-${uniq}@local.test`);
      const page = await context.newPage();

      await page.route("**/api/archidoc/projects", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([FAKE_PROJECT(uniq)]),
        }),
      );
      await page.route("**/api/archidoc/sync", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, failures: ["projects sync failed (e2e)"] }),
        }),
      );

      await page.goto("/projets");
      await page.getByTestId("button-new-project").click();
      await page.getByTestId("button-sync-archidoc").click();

      await expect(
        page.getByText("Sync finished with errors", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("projects sync failed (e2e)", { exact: true }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("sync while another is running toasts 'Sync already in progress'", async ({ browser }) => {
    const uniq = uniqSuffix();
    const context = await browser.newContext();

    try {
      await devLogin(context.request, `e2e-picker-syncbusy-${uniq}@local.test`);
      const page = await context.newPage();

      await page.route("**/api/archidoc/projects", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([FAKE_PROJECT(uniq)]),
        }),
      );
      await page.route("**/api/archidoc/sync", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, alreadyRunning: true }),
        }),
      );

      await page.goto("/projets");
      await page.getByTestId("button-new-project").click();
      await page.getByTestId("button-sync-archidoc").click();

      await expect(
        page.getByText("Sync already in progress", { exact: true }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
