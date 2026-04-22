import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * E2E coverage for the inline-edit French description flow on the Devis Line Items
 * table (introduced in task #66, see `.local/tasks/inline-edit-french-line-items.md`).
 *
 * Requires the dev server with NODE_ENV=development AND
 * ENABLE_DEV_LOGIN_FOR_E2E=true so `POST /api/auth/dev-login` is registered.
 *
 * Covers:
 *   - Happy path: click cell -> edit -> Save -> success toast and persisted via
 *     PATCH /api/line-items/:id.
 *   - Escape path: edit -> Escape -> previous text restored, no PATCH issued.
 *   - Error path: PATCH intercepted at the network layer to return 500 -> destructive
 *     toast, previous text restored, DB unchanged.
 */

type Seed = {
  projectId: number;
  contractorId: number;
  devisId: number;
  lineItemId: number;
  errorLineItemId: number;
  uniq: string;
};

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function postOk<T = unknown>(api: APIRequestContext, url: string, body: unknown): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `${url} failed: ${res.status()} ${await safeText(res)}`).toBe(true);
  return (await res.json()) as T;
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

async function seed(api: APIRequestContext, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `InlineEdit Test ${uniq}`,
    code: `IE-${uniq}`,
    clientName: "Test Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `Inline Edit Co ${uniq}`,
  });
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `DEV-${uniq}`,
    descriptionFr: "Devis for inline edit test",
    amountHt: "1000.00",
    amountTtc: "1200.00",
    invoicingMode: "mode_b",
  });
  const lineOne = await postOk<{ id: number }>(api, `/api/devis/${devis.id}/line-items`, {
    lineNumber: 1,
    description: "Original FR description",
    quantity: "1",
    unit: "u",
    unitPriceHt: "100.00",
    totalHt: "100.00",
  });
  const lineTwo = await postOk<{ id: number }>(api, `/api/devis/${devis.id}/line-items`, {
    lineNumber: 2,
    description: "Second line for error path",
    quantity: "1",
    unit: "u",
    unitPriceHt: "50.00",
    totalHt: "50.00",
  });
  return {
    projectId: project.id,
    contractorId: contractor.id,
    devisId: devis.id,
    lineItemId: lineOne.id,
    errorLineItemId: lineTwo.id,
    uniq,
  };
}

test.describe("Devis line items — inline-edit French description", () => {
  test("happy path, escape, and forced PATCH failure", async ({ browser }) => {
    const uniq = `e2e${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-inline-edit-${uniq}@local.test`;

    // One context = one cookie jar shared by both Playwright's HTTP API and the page.
    const context = await browser.newContext();
    try {
      await devLogin(context.request, email);
      const data = await seed(context.request, uniq);

      // Sanity: the API returns both line items.
      const initial = await context.request.get(`/api/devis/${data.devisId}/line-items`);
      expect(initial.ok()).toBe(true);
      const initialItems = (await initial.json()) as Array<{ id: number; description: string }>;
      expect(initialItems.map((li) => li.id).sort()).toEqual(
        [data.lineItemId, data.errorLineItemId].sort(),
      );

      const page = await context.newPage();
      await page.goto(`/projets/${data.projectId}`);
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${data.devisId}`).click();

      const cell = page.getByTestId(`cell-line-description-${data.lineItemId}`);
      const errCell = page.getByTestId(`cell-line-description-${data.errorLineItemId}`);
      await expect(cell).toHaveText("Original FR description");
      await expect(errCell).toHaveText("Second line for error path");

      // -------- Happy path --------
      const updated = `Updated FR description ${data.uniq}`;
      await cell.click();
      const ta = page.getByTestId(`textarea-line-description-${data.lineItemId}`);
      await expect(ta).toBeVisible();
      await ta.fill(updated);
      await page.getByTestId(`button-save-line-description-${data.lineItemId}`).click();

      await expect(page.getByText("Description updated", { exact: true })).toBeVisible({
        timeout: 5_000,
      });
      await expect(ta).toBeHidden();
      await expect(cell).toHaveText(updated);

      const afterSave = await context.request.get(`/api/devis/${data.devisId}/line-items`);
      const afterSaveItems = (await afterSave.json()) as Array<{ id: number; description: string }>;
      expect(afterSaveItems.find((li) => li.id === data.lineItemId)?.description).toBe(updated);

      // -------- Escape path --------
      await cell.click();
      await expect(ta).toBeVisible();
      await ta.fill(`Should NOT be saved ${data.uniq}`);
      await ta.press("Escape");
      await expect(ta).toBeHidden();
      await expect(cell).toHaveText(updated);

      const afterEscape = await context.request.get(`/api/devis/${data.devisId}/line-items`);
      const afterEscapeItems = (await afterEscape.json()) as Array<{ id: number; description: string }>;
      expect(afterEscapeItems.find((li) => li.id === data.lineItemId)?.description).toBe(updated);

      // -------- Error path: force PATCH 500 via network interception --------
      const patchPattern = `**/api/line-items/${data.errorLineItemId}`;
      await page.route(patchPattern, async (route) => {
        if (route.request().method() === "PATCH") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ message: "Forced test failure" }),
          });
        } else {
          await route.continue();
        }
      });

      await errCell.click();
      const errTa = page.getByTestId(`textarea-line-description-${data.errorLineItemId}`);
      await expect(errTa).toBeVisible();
      await errTa.fill(`Attempted edit that will fail ${data.uniq}`);
      await page.getByTestId(`button-save-line-description-${data.errorLineItemId}`).click();

      await expect(page.getByText("Couldn't update description", { exact: true })).toBeVisible({
        timeout: 5_000,
      });
      await expect(errTa).toBeHidden();
      await expect(errCell).toHaveText("Second line for error path");

      await page.unroute(patchPattern);

      const afterError = await context.request.get(`/api/devis/${data.devisId}/line-items`);
      const afterErrorItems = (await afterError.json()) as Array<{ id: number; description: string }>;
      expect(afterErrorItems.find((li) => li.id === data.errorLineItemId)?.description).toBe(
        "Second line for error path",
      );
    } finally {
      await context.close();
    }
  });
});
