import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * E2E coverage for drag-and-drop upload on the intake tab card (task: make
 * drag-and-drop actually work on the intake upload card).
 *
 * Requires the dev server with NODE_ENV=development AND
 * ENABLE_DEV_LOGIN_FOR_E2E=true so `POST /api/auth/dev-login` is registered.
 *
 * Covers:
 *   - Drag-over shows the highlighted drop state (data-dragover="true").
 *   - Dropping a supported file uploads it via the existing multi-file flow
 *     (success toast, new intake row appears).
 *   - Dropping an unsupported file type shows a clear rejection toast and
 *     does not upload.
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function seedProject(api: APIRequestContext, uniq: string): Promise<number> {
  const res = await api.post("/api/projects", {
    data: { name: `DnD Test ${uniq}`, code: `DND-${uniq}`, clientName: "Test Client" },
  });
  expect(res.ok(), `project create failed: ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: number }).id;
}

/** Dispatch dragenter/dragover/drop on the card with a real DataTransfer containing the file. */
async function dropFile(page: Page, name: string, mimeType: string, content: string) {
  const dataTransfer = await page.evaluateHandle(
    ({ name, mimeType, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: mimeType }));
      return dt;
    },
    { name, mimeType, content },
  );
  const card = page.getByTestId("card-intake-upload");
  await card.dispatchEvent("dragenter", { dataTransfer });
  await card.dispatchEvent("dragover", { dataTransfer });
  await card.dispatchEvent("drop", { dataTransfer });
}

test("drag-and-drop on the intake card: highlight, upload, and unsupported rejection", async ({ page, request }) => {
  const uniq = `${Date.now()}`.slice(-8);
  await devLogin(request, "dnd-e2e@renosud.com");
  const projectId = await seedProject(request, uniq);

  // Share auth with the page context.
  await devLogin(page.request, "dnd-e2e@renosud.com");
  await page.goto(`/projets/${projectId}`);
  await page.getByTestId("tab-intake").click();

  const card = page.getByTestId("card-intake-upload");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-dragover", "false");

  // 1. Drag-over highlight state.
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(["x"], "hover.pdf", { type: "application/pdf" }));
    return d;
  });
  await card.dispatchEvent("dragenter", { dataTransfer: dt });
  await expect(card).toHaveAttribute("data-dragover", "true");
  await card.dispatchEvent("dragleave", { dataTransfer: dt });
  await expect(card).toHaveAttribute("data-dragover", "false");

  // 2. Drop a supported file -> uploaded through the multi-file flow.
  await dropFile(page, `dnd-doc-${uniq}.pdf`, "application/pdf", "%PDF-1.4 fake pdf for dnd test");
  await expect(page.getByText("Document uploaded").first()).toBeVisible();
  await expect(page.getByTestId("list-intake-docs")).toContainText(`dnd-doc-${uniq}.pdf`);
  await expect(card).toHaveAttribute("data-dragover", "false");

  // 3. Drop an unsupported file -> clear rejection, no upload.
  await dropFile(page, `evil-${uniq}.exe`, "application/octet-stream", "MZ not really");
  await expect(page.getByText("Unsupported file type").first()).toBeVisible();
  await expect(page.getByTestId("list-intake-docs")).not.toContainText(`evil-${uniq}.exe`);
});
