import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * The status endpoint deliberately returns after a short bounded wait while
 * its real ArchiDoc probe continues in the background. A pending response is
 * neither an outage nor a completed health check; the Projects header must
 * say "Checking" and poll until it receives a final verdict.
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

function suffix() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

const baseStatus = {
  configured: true,
  syncInProgress: false,
  lastSync: null,
  mirroredProjects: 0,
  mirroredContractors: 0,
  trackedProjects: 0,
};

test.describe("Projects — ArchiDoc connection status", () => {
  test("shows Checking while pending, polls, then shows Connected", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      await devLogin(context.request, `e2e-archidoc-checking-${suffix()}@local.test`);
      const page = await context.newPage();
      let statusCalls = 0;

      await page.route("**/api/archidoc/status", async (route) => {
        statusCalls++;
        const pending = statusCalls === 1;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...baseStatus,
            connected: !pending,
            connectionPending: pending,
            connectionError: pending ? "Connectivity check in progress" : undefined,
          }),
        });
      });

      await page.goto("/projets");
      const badge = page.getByTestId("text-archidoc-connection-status");
      await expect(badge).toHaveText("ArchiDoc Checking");
      await expect(page.getByTestId("text-archidoc-connection-error")).toHaveCount(0);

      // connectionPending enables the three-second status poll; the second
      // mocked response is the completed successful health check.
      await expect(badge).toHaveText("ArchiDoc Connected", { timeout: 8_000 });
      expect(statusCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await context.close();
    }
  });

  test("shows Offline and the returned diagnostic only after a completed failed check", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      await devLogin(context.request, `e2e-archidoc-offline-${suffix()}@local.test`);
      const page = await context.newPage();
      const diagnostic = "ArchiDoc API error 401: Unauthorized";

      await page.route("**/api/archidoc/status", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...baseStatus,
            connected: false,
            connectionPending: false,
            connectionError: diagnostic,
          }),
        }),
      );

      await page.goto("/projets");
      await expect(page.getByTestId("text-archidoc-connection-status")).toHaveText(
        "ArchiDoc Offline",
      );
      await expect(page.getByTestId("text-archidoc-connection-error")).toHaveText(
        `— ${diagnostic}`,
      );
    } finally {
      await context.close();
    }
  });
});