import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the per-row quick-action buttons (Facture / Avenant)
 * added to the collapsed devis row in task #97.
 *
 * Verifies:
 *   1. Both quick buttons open their dialog without toggling the row
 *      (the in-panel buttons remain hidden after the click).
 *   2. The quick buttons and the in-panel buttons (revealed once the row is
 *      expanded) open the same canonical dialogs (same dialog testids).
 *   3. The TTC totals on three rows with very different magnitudes share the
 *      same X coordinate — i.e. the fixed-slot row layout actually lines up.
 *   4. Quick-action buttons are HIDDEN when status === "void", and DISABLED
 *      when the project is archived.
 *
 * Hermetic against unrelated dev-DB drift: every devis is created on a
 * brand-new project (no other projects' rows pollute the list), and the row
 * lookups are scoped to the seeded ids.
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true so that
 * POST /api/auth/dev-login is registered, plus DATABASE_URL so we can flip
 * one devis to status="void" (no public API for that transition).
 */

interface SeededDevis {
  id: number;
  amountTtc: string;
  amountHt: string;
}

interface ActiveSeed {
  projectId: number;
  contractorId: number;
  small: SeededDevis;
  medium: SeededDevis;
  large: SeededDevis;
  voided: SeededDevis;
}

interface ArchivedSeed {
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

async function createDevis(
  api: APIRequestContext,
  projectId: number,
  contractorId: number,
  uniq: string,
  tag: string,
  amountHt: string,
  amountTtc: string,
): Promise<SeededDevis> {
  const created = await postOk<{ id: number; amountHt: string; amountTtc: string }>(
    api,
    `/api/projects/${projectId}/devis`,
    {
      contractorId,
      devisCode: `QA-${tag}-${uniq}`,
      descriptionFr: `Quick-actions ${tag} ${uniq}`,
      amountHt,
      amountTtc,
      invoicingMode: "mode_b",
    },
  );
  return { id: created.id, amountHt: created.amountHt, amountTtc: created.amountTtc };
}

async function seedActive(api: APIRequestContext, uniq: string): Promise<ActiveSeed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `QuickActions Active ${uniq}`,
    code: `QA-A-${uniq}`,
    clientName: "QA Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `QA Co ${uniq}`,
  });
  // Magnitudes intentionally span 5 orders of magnitude so any layout drift
  // between rows would show up as a TTC-text X-coordinate mismatch.
  const small = await createDevis(api, project.id, contractor.id, uniq, "S", "12.34", "14.81");
  const medium = await createDevis(api, project.id, contractor.id, uniq, "M", "5678.90", "6814.68");
  const large = await createDevis(api, project.id, contractor.id, uniq, "L", "1234567.89", "1481481.47");
  const voided = await createDevis(api, project.id, contractor.id, uniq, "V", "99.00", "118.80");
  return { projectId: project.id, contractorId: contractor.id, small, medium, large, voided };
}

async function seedArchived(api: APIRequestContext, uniq: string): Promise<ArchivedSeed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `QuickActions Archived ${uniq}`,
    code: `QA-Z-${uniq}`,
    clientName: "QA Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `QA Arch Co ${uniq}`,
  });
  const devis = await createDevis(api, project.id, contractor.id, uniq, "Z", "100.00", "120.00");
  const archived = await api.post(`/api/projects/${project.id}/archive`, { data: {} });
  expect(
    archived.ok(),
    `archive failed: ${archived.status()} ${await safeText(archived)}`,
  ).toBe(true);
  return { projectId: project.id, contractorId: contractor.id, devis };
}

async function cleanup(
  db: Client,
  active: ActiveSeed | null,
  archived: ArchivedSeed | null,
) {
  const stmts: Array<[string, unknown[]]> = [];
  if (active) {
    const ids = [active.small.id, active.medium.id, active.large.id, active.voided.id];
    stmts.push(["DELETE FROM avenants WHERE devis_id = ANY($1::int[])", [ids]]);
    stmts.push(["DELETE FROM invoices WHERE devis_id = ANY($1::int[])", [ids]]);
    stmts.push(["DELETE FROM devis_line_items WHERE devis_id = ANY($1::int[])", [ids]]);
    stmts.push(["DELETE FROM devis WHERE id = ANY($1::int[])", [ids]]);
    stmts.push(["DELETE FROM projects WHERE id = $1", [active.projectId]]);
    stmts.push(["DELETE FROM contractors WHERE id = $1", [active.contractorId]]);
  }
  if (archived) {
    stmts.push(["DELETE FROM avenants WHERE devis_id = $1", [archived.devis.id]]);
    stmts.push(["DELETE FROM invoices WHERE devis_id = $1", [archived.devis.id]]);
    stmts.push(["DELETE FROM devis_line_items WHERE devis_id = $1", [archived.devis.id]]);
    stmts.push(["DELETE FROM devis WHERE id = $1", [archived.devis.id]]);
    stmts.push(["DELETE FROM projects WHERE id = $1", [archived.projectId]]);
    stmts.push(["DELETE FROM contractors WHERE id = $1", [archived.contractorId]]);
  }
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[quick-actions cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Devis — quick-action Facture / Avenant buttons (task #97)", () => {
  test("open dialogs without toggling, share canonical dialog, align totals, hide on void, disable when archived", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-quick-actions-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let active: ActiveSeed | null = null;
    let archived: ArchivedSeed | null = null;

    try {
      await devLogin(context.request, email);
      active = await seedActive(context.request, uniq);
      archived = await seedArchived(context.request, uniq);

      // Flip the 4th devis to status=void via DB (no public API for that
      // transition). The active project still hosts S/M/L active devis +
      // the void one (visible only via the "Show Void" toggle).
      await db.query("UPDATE devis SET status = 'void' WHERE id = $1", [active.voided.id]);

      const page = await context.newPage();
      await page.goto(`/projets/${active.projectId}`);
      await page.getByTestId("tab-devis").click();

      const sId = active.small.id;
      const mId = active.medium.id;
      const lId = active.large.id;
      const vId = active.voided.id;

      // All three active rows render their quick buttons.
      const quickFactureS = page.getByTestId(`button-quick-upload-invoice-${sId}`);
      const quickAvenantS = page.getByTestId(`button-quick-add-avenant-${sId}`);
      await expect(quickFactureS).toBeVisible();
      await expect(quickAvenantS).toBeVisible();
      await expect(page.getByTestId(`button-quick-upload-invoice-${mId}`)).toBeVisible();
      await expect(page.getByTestId(`button-quick-upload-invoice-${lId}`)).toBeVisible();

      // ---------- 1. Quick Facture opens dialog WITHOUT toggling the row ----------
      await quickFactureS.click();
      const factureDropzoneS = page.getByTestId(`dropzone-invoice-upload-${sId}`);
      await expect(factureDropzoneS).toBeVisible();
      // The in-panel button only renders when the row is expanded; it must
      // remain hidden — proving the row was NOT toggled.
      await expect(page.getByTestId(`button-upload-invoice-${sId}`)).toHaveCount(0);
      // Close the dialog (Escape) and confirm collapsed state persists.
      await page.keyboard.press("Escape");
      await expect(factureDropzoneS).toBeHidden();
      await expect(page.getByTestId(`button-upload-invoice-${sId}`)).toHaveCount(0);

      // ---------- 2. Quick Avenant opens dialog WITHOUT toggling the row ----------
      await quickAvenantS.click();
      const avenantInputS = page.getByTestId("input-avenant-desc");
      await expect(avenantInputS).toBeVisible();
      await expect(page.getByTestId(`button-add-avenant-${sId}`)).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(avenantInputS).toBeHidden();

      // ---------- 3. Quick + in-panel buttons open the SAME canonical dialog ----------
      // Expand the medium row, then click the in-panel buttons; the dialogs
      // exposed must carry the same testids as the quick-button flow.
      await page.getByTestId(`row-devis-toggle-${mId}`).click();
      const inPanelFactureM = page.getByTestId(`button-upload-invoice-${mId}`);
      await expect(inPanelFactureM).toBeVisible();
      await inPanelFactureM.click();
      await expect(page.getByTestId(`dropzone-invoice-upload-${mId}`)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(`dropzone-invoice-upload-${mId}`)).toBeHidden();

      const inPanelAvenantM = page.getByTestId(`button-add-avenant-${mId}`);
      await expect(inPanelAvenantM).toBeVisible();
      await inPanelAvenantM.click();
      await expect(page.getByTestId("input-avenant-desc")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("input-avenant-desc")).toBeHidden();

      // Quick button on the same expanded row also opens the canonical dialog.
      await page.getByTestId(`button-quick-upload-invoice-${mId}`).click();
      await expect(page.getByTestId(`dropzone-invoice-upload-${mId}`)).toBeVisible();
      await page.keyboard.press("Escape");

      // Collapse the medium row before measuring totals so all three rows
      // are in the same (collapsed) state for the alignment check.
      await page.getByTestId(`row-devis-toggle-${mId}`).click();
      await expect(page.getByTestId(`button-upload-invoice-${mId}`)).toHaveCount(0);

      // ---------- 4. TTC totals share the same X coordinate ----------
      const ttcS = await page.getByTestId(`text-devis-ttc-${sId}`).boundingBox();
      const ttcM = await page.getByTestId(`text-devis-ttc-${mId}`).boundingBox();
      const ttcL = await page.getByTestId(`text-devis-ttc-${lId}`).boundingBox();
      expect(ttcS, "TTC bbox missing for small row").not.toBeNull();
      expect(ttcM, "TTC bbox missing for medium row").not.toBeNull();
      expect(ttcL, "TTC bbox missing for large row").not.toBeNull();
      // Right edges should coincide (slot is right-aligned, fixed width).
      const rightS = ttcS!.x + ttcS!.width;
      const rightM = ttcM!.x + ttcM!.width;
      const rightL = ttcL!.x + ttcL!.width;
      expect(Math.abs(rightS - rightM)).toBeLessThan(1);
      expect(Math.abs(rightS - rightL)).toBeLessThan(1);

      // ---------- 5a. Void: quick buttons HIDDEN ----------
      // Reveal void rows via the toggle, then assert no quick buttons render.
      await page.getByTestId("button-toggle-void").click();
      await expect(page.getByTestId(`card-devis-${vId}`)).toBeVisible();
      await expect(page.getByTestId(`button-quick-upload-invoice-${vId}`)).toHaveCount(0);
      await expect(page.getByTestId(`button-quick-add-avenant-${vId}`)).toHaveCount(0);

      // ---------- 5b. Archived project: quick buttons DISABLED ----------
      const archPage = await context.newPage();
      await archPage.goto(`/projets/${archived.projectId}`);
      await archPage.getByTestId("tab-devis").click();
      const archDevisId = archived.devis.id;
      const archFacture = archPage.getByTestId(`button-quick-upload-invoice-${archDevisId}`);
      const archAvenant = archPage.getByTestId(`button-quick-add-avenant-${archDevisId}`);
      await expect(archFacture).toBeVisible();
      await expect(archAvenant).toBeVisible();
      await expect(archFacture).toBeDisabled();
      await expect(archAvenant).toBeDisabled();
    } finally {
      try {
        await cleanup(db, active, archived);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
