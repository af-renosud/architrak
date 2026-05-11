import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the in-app PDF pop-out viewer added in task #191.
 *
 * Verifies:
 *   1. The collapsed-row FileText icon is disabled with a "No PDF on file"
 *      tooltip when devis.pdfStorageKey is null, and does NOT use
 *      window.open to navigate to the PDF endpoint.
 *   2. After expanding the row and seeding a pdfStorageKey directly in the
 *      DB, the prominent "View PDF" button in the DevisDetailInline header
 *      becomes enabled.
 *   3. Clicking either the prominent button or the icon opens the same
 *      in-app pop-out dialog (NOT a new tab) with the iframe pointing at
 *      /api/devis/:id/pdf and the close button + Esc both close it.
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true so that
 * POST /api/auth/dev-login is registered, plus DATABASE_URL so we can
 * stub a pdfStorageKey onto the seeded devis.
 */

interface SeededDevis {
  id: number;
}

interface Seed {
  projectId: number;
  contractorId: number;
  devis: SeededDevis;
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function postOk<T = unknown>(
  api: APIRequestContext,
  url: string,
  body: unknown,
): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `${url} failed: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function seed(api: APIRequestContext, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `PdfPopout ${uniq}`,
    code: `PP-${uniq}`,
    clientName: "PP Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `PP Co ${uniq}`,
  });
  const devis = await postOk<{ id: number }>(
    api,
    `/api/projects/${project.id}/devis`,
    {
      contractorId: contractor.id,
      devisCode: `PP-D-${uniq}`,
      descriptionFr: `PdfPopout devis ${uniq}`,
      amountHt: "100.00",
      amountTtc: "120.00",
      invoicingMode: "mode_a",
    },
  );
  return { projectId: project.id, contractorId: contractor.id, devis };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM devis_translations WHERE devis_id = $1", [s.devis.id]],
    ["DELETE FROM devis_line_items WHERE devis_id = $1", [s.devis.id]],
    ["DELETE FROM devis WHERE id = $1", [s.devis.id]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[pdf-popout cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Devis PDF pop-out viewer (task #191)", () => {
  test("disabled without PDF; opens in-app pop-out (not new tab) when PDF present; Esc closes", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-pdf-popout-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(context.request, uniq);

      const page = await context.newPage();

      // Track any new pages — there must be NONE: the pop-out is in-app.
      const newPages: string[] = [];
      context.on("page", (p) => newPages.push(p.url()));

      await page.goto(`/projets/${s.projectId}`);
      await page.getByTestId("tab-devis").click();

      const devisId = s.devis.id;
      const iconBtn = page.getByTestId(`button-view-pdf-${devisId}`);

      // ---------- 1. Without a PDF: icon disabled + "No PDF on file" tooltip ----------
      await expect(iconBtn).toBeVisible();
      await expect(iconBtn).toBeDisabled();
      await iconBtn.hover({ force: true });
      await expect(page.getByText("No PDF on file").first()).toBeVisible();

      // Expand row to reveal the prominent button — also disabled.
      await page.getByTestId(`row-devis-toggle-${devisId}`).click();
      const prominentBtn = page.getByTestId(`button-view-pdf-prominent-${devisId}`);
      await expect(prominentBtn).toBeVisible();
      await expect(prominentBtn).toBeDisabled();

      // ---------- 2. Stub a pdfStorageKey directly in the DB ----------
      // The /api/devis/:id/pdf endpoint will 404 because the storage key
      // doesn't reference a real object, but the iframe still loads with
      // the right URL — we assert on the URL, not the response body.
      await db.query(
        "UPDATE devis SET pdf_storage_key = $1, pdf_file_name = $2 WHERE id = $3",
        [`stub/${uniq}.pdf`, `stub-${uniq}.pdf`, devisId],
      );
      await page.reload();
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${devisId}`).click();

      const iconBtn2 = page.getByTestId(`button-view-pdf-${devisId}`);
      const prominentBtn2 = page.getByTestId(`button-view-pdf-prominent-${devisId}`);
      await expect(iconBtn2).toBeEnabled();
      await expect(prominentBtn2).toBeEnabled();

      // ---------- 3. Prominent button opens in-app pop-out (no new tab) ----------
      await prominentBtn2.click();
      const dialog = page.getByTestId(`dialog-pdf-popout-${devisId}`);
      await expect(dialog).toBeVisible();
      const iframe = page.getByTestId(`pdf-popout-iframe-${devisId}`);
      await expect(iframe).toHaveAttribute(
        "src",
        new RegExp(`/api/devis/${devisId}/pdf\\?variant=`),
      );
      // No new browser tab/window was opened.
      expect(newPages, `unexpected new pages: ${JSON.stringify(newPages)}`).toEqual([]);

      // Esc closes.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // ---------- 4. Icon button opens the same pop-out ----------
      await iconBtn2.click();
      const dialog2 = page.getByTestId(`dialog-pdf-popout-${devisId}`);
      await expect(dialog2).toBeVisible();

      // ---------- 5. Minimize / restore preserves frame ----------
      const minimizeBtn = page.getByTestId(`button-pdf-popout-minimize-${devisId}`);
      await minimizeBtn.click();
      await expect(dialog2).toHaveAttribute("data-minimized", "true");
      // Iframe (or error/retry) chrome is gone in collapsed mode.
      await expect(page.getByTestId(`pdf-popout-iframe-${devisId}`)).toHaveCount(0);
      await expect(page.getByTestId(`pdf-popout-error-${devisId}`)).toHaveCount(0);
      await minimizeBtn.click();
      await expect(dialog2).toHaveAttribute("data-minimized", "false");

      // ---------- 6. Stub HEAD /api/devis/:id/pdf to fail; retry button shown ----------
      // Force the variant switch path through an aborted response so the
      // viewer surfaces its retry-able error UI rather than a blank iframe.
      await page.route(`**/api/devis/${devisId}/pdf?variant=*`, (route) => {
        if (route.request().method() === "HEAD") {
          return route.fulfill({ status: 502, body: "" });
        }
        return route.continue();
      });
      // Trigger a re-probe by closing & re-opening so the HEAD fetch fires
      // against the now-stubbed endpoint.
      await page.getByTestId(`button-pdf-popout-close-${devisId}`).click();
      await expect(dialog2).toHaveCount(0);
      await iconBtn2.click();
      await expect(page.getByTestId(`pdf-popout-error-${devisId}`)).toBeVisible();
      await expect(
        page.getByTestId(`button-pdf-popout-retry-${devisId}`),
      ).toBeVisible();

      // Unroute and retry → iframe should appear again.
      await page.unroute(`**/api/devis/${devisId}/pdf?variant=*`);
      await page.getByTestId(`button-pdf-popout-retry-${devisId}`).click();
      await expect(page.getByTestId(`pdf-popout-iframe-${devisId}`)).toBeVisible();

      // ---------- 7. Variant selector hidden when only one variant ----------
      // Without a translation row, only "original" is available — selector
      // is suppressed by design.
      await expect(
        page.getByTestId(`select-pdf-variant-${devisId}`),
      ).toHaveCount(0);
      await page.getByTestId(`button-pdf-popout-close-${devisId}`).click();
      await expect(dialog2).toHaveCount(0);

      // ---------- 8. Translation present → selector visible, defaults to combined ----------
      // Seed a finalised translation row directly in the DB. The shared
      // translation-status helper considers draft / edited / finalised as
      // "ready"; finalised is the strongest signal.
      await db.query(
        `INSERT INTO devis_translations (devis_id, status, line_translations, header_translated, updated_at)
         VALUES ($1, 'finalised', '[]'::jsonb, '{}'::jsonb, NOW())
         ON CONFLICT (devis_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
        [devisId],
      );
      // Reopen — query refetches translation status, default should land
      // on `combined` per server-side fallback parity.
      await iconBtn2.click();
      await expect(dialog2).toBeVisible();
      const variantSelect = page.getByTestId(`select-pdf-variant-${devisId}`);
      await expect(variantSelect).toBeVisible();
      // Iframe URL reflects the chosen default.
      await expect(page.getByTestId(`pdf-popout-iframe-${devisId}`)).toHaveAttribute(
        "src",
        new RegExp(`/api/devis/${devisId}/pdf\\?variant=combined`),
      );
      // Switch to translation and verify iframe URL updates.
      await variantSelect.click();
      await page
        .getByTestId(`select-pdf-variant-${devisId}-option-translation`)
        .click();
      await expect(page.getByTestId(`pdf-popout-iframe-${devisId}`)).toHaveAttribute(
        "src",
        new RegExp(`/api/devis/${devisId}/pdf\\?variant=translation`),
      );
      // Switch to original.
      await variantSelect.click();
      await page
        .getByTestId(`select-pdf-variant-${devisId}-option-original`)
        .click();
      await expect(page.getByTestId(`pdf-popout-iframe-${devisId}`)).toHaveAttribute(
        "src",
        new RegExp(`/api/devis/${devisId}/pdf\\?variant=original`),
      );

      // Final guard: still no new tabs anywhere in the flow.
      expect(newPages, `unexpected new pages: ${JSON.stringify(newPages)}`).toEqual([]);
    } finally {
      try {
        await cleanup(db, s);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });

  test("download anchor reflects current variant; window frame is remembered across reopen", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-pdf-popout-frame-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(context.request, uniq);
      const devisId = s.devis.id;
      const devisCode = `PP-D-${uniq}`;

      // Stub a pdfStorageKey + a finalised translation so both the
      // variant selector and the download link become meaningful.
      await db.query(
        "UPDATE devis SET pdf_storage_key = $1, pdf_file_name = $2 WHERE id = $3",
        [`stub/${uniq}.pdf`, `stub-${uniq}.pdf`, devisId],
      );
      await db.query(
        `INSERT INTO devis_translations (devis_id, status, line_translations, header_translated, updated_at)
         VALUES ($1, 'finalised', '[]'::jsonb, '{}'::jsonb, NOW())
         ON CONFLICT (devis_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
        [devisId],
      );

      const page = await context.newPage();
      // Clear any frame remembered from a previous run within the
      // same browser context so we start from the centred default.
      await page.addInitScript(() => {
        try {
          sessionStorage.removeItem("architrak.pdfPopout.frame");
        } catch {
          /* ignore */
        }
      });

      // Suppress real downloads — we only assert the anchor attributes.
      await page.route(`**/api/devis/${devisId}/pdf?variant=*`, (route) => {
        if (route.request().method() === "HEAD") {
          return route.fulfill({
            status: 200,
            headers: { "content-type": "application/pdf" },
            body: "",
          });
        }
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/pdf" },
          body: "%PDF-1.4\n%stub\n",
        });
      });

      await page.goto(`/projets/${s.projectId}`);
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${devisId}`).click();

      const iconBtn = page.getByTestId(`button-view-pdf-${devisId}`);
      await expect(iconBtn).toBeEnabled();
      await iconBtn.click();

      const dialog = page.getByTestId(`dialog-pdf-popout-${devisId}`);
      await expect(dialog).toBeVisible();

      // ---------- Download anchor: defaults to combined ----------
      const downloadLink = page.getByTestId(`button-pdf-download-${devisId}`);
      await expect(downloadLink).toHaveAttribute(
        "href",
        `/api/devis/${devisId}/pdf?variant=combined`,
      );
      await expect(downloadLink).toHaveAttribute(
        "download",
        `DEVIS-${devisCode}-combined.pdf`,
      );

      // Switch variant → both href AND download filename update in lockstep.
      const variantSelect = page.getByTestId(`select-pdf-variant-${devisId}`);
      await variantSelect.click();
      await page
        .getByTestId(`select-pdf-variant-${devisId}-option-translation`)
        .click();
      await expect(downloadLink).toHaveAttribute(
        "href",
        `/api/devis/${devisId}/pdf?variant=translation`,
      );
      await expect(downloadLink).toHaveAttribute(
        "download",
        `DEVIS-${devisCode}-translation.pdf`,
      );

      await variantSelect.click();
      await page
        .getByTestId(`select-pdf-variant-${devisId}-option-original`)
        .click();
      await expect(downloadLink).toHaveAttribute(
        "href",
        `/api/devis/${devisId}/pdf?variant=original`,
      );
      await expect(downloadLink).toHaveAttribute(
        "download",
        `DEVIS-${devisCode}-original.pdf`,
      );

      // ---------- Drag the dialog via the title bar handle ----------
      const handle = page.getByTestId(`pdf-popout-handle-${devisId}`);
      const handleBox = await handle.boundingBox();
      expect(handleBox, "drag handle must have a bounding box").not.toBeNull();
      const startX = handleBox!.x + 30;
      const startY = handleBox!.y + handleBox!.height / 2;
      const dragDx = 140;
      const dragDy = 90;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + dragDx / 2, startY + dragDy / 2, {
        steps: 5,
      });
      await page.mouse.move(startX + dragDx, startY + dragDy, { steps: 5 });
      await page.mouse.up();

      // ---------- Resize via the bottom-right grip ----------
      const resize = page.getByTestId(`pdf-popout-resize-${devisId}`);
      const rBox = await resize.boundingBox();
      expect(rBox, "resize grip must have a bounding box").not.toBeNull();
      const resizeStartX = rBox!.x + rBox!.width / 2;
      const resizeStartY = rBox!.y + rBox!.height / 2;
      const resizeDx = 120;
      const resizeDy = 80;
      await page.mouse.move(resizeStartX, resizeStartY);
      await page.mouse.down();
      await page.mouse.move(
        resizeStartX + resizeDx / 2,
        resizeStartY + resizeDy / 2,
        { steps: 5 },
      );
      await page.mouse.move(
        resizeStartX + resizeDx,
        resizeStartY + resizeDy,
        { steps: 5 },
      );
      await page.mouse.up();

      // Capture the frame as actually rendered after drag + resize.
      const captured = await dialog.evaluate((el) => {
        const s = (el as HTMLElement).style;
        return {
          left: parseFloat(s.left),
          top: parseFloat(s.top),
          width: parseFloat(s.width),
          height: parseFloat(s.height),
        };
      });
      expect(captured.width).toBeGreaterThan(0);
      expect(captured.height).toBeGreaterThan(0);

      // sessionStorage should mirror the rendered frame.
      const stored = await page.evaluate(() =>
        window.sessionStorage.getItem("architrak.pdfPopout.frame"),
      );
      expect(stored, "frame should be persisted to sessionStorage").toBeTruthy();
      const parsed = JSON.parse(stored!) as {
        x: number;
        y: number;
        w: number;
        h: number;
        minimized?: boolean;
      };
      expect(parsed.x).toBeCloseTo(captured.left, 0);
      expect(parsed.y).toBeCloseTo(captured.top, 0);
      expect(parsed.w).toBeCloseTo(captured.width, 0);
      expect(parsed.h).toBeCloseTo(captured.height, 0);

      // ---------- Close & reopen → frame must be restored ----------
      await page.getByTestId(`button-pdf-popout-close-${devisId}`).click();
      await expect(dialog).toHaveCount(0);

      await page.getByTestId(`button-view-pdf-${devisId}`).click();
      const dialog2 = page.getByTestId(`dialog-pdf-popout-${devisId}`);
      await expect(dialog2).toBeVisible();
      const restored = await dialog2.evaluate((el) => {
        const s = (el as HTMLElement).style;
        return {
          left: parseFloat(s.left),
          top: parseFloat(s.top),
          width: parseFloat(s.width),
          height: parseFloat(s.height),
        };
      });
      expect(restored.left).toBeCloseTo(captured.left, 0);
      expect(restored.top).toBeCloseTo(captured.top, 0);
      expect(restored.width).toBeCloseTo(captured.width, 0);
      expect(restored.height).toBeCloseTo(captured.height, 0);
    } finally {
      try {
        await cleanup(db, s);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
