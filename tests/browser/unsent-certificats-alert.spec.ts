import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * Task #539 — "Awaiting certificat send" dashboard alert + per-devis
 * certificat section.
 *
 * Verifies:
 *   1. Dashboard shows the amber "Awaiting certificat send" card with count
 *      when a ready-but-unsent certificat exists.
 *   2. Clicking the card opens the dialog listing the certificat with
 *      project name, ref, contractor and a per-row Send button.
 *   3. Inside the devis (signed-off stage), the certificat panel renders the
 *      ready certificat with a Send button.
 *
 * The actual send action reuses the long-standing send endpoint (already
 * covered elsewhere) and requires the PDF seal pipeline, so it is not
 * exercised here.
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true plus
 * DATABASE_URL for seeding.
 */

async function postOk<T = unknown>(
  api: APIRequestContext,
  url: string,
  body: unknown,
): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(
    res.ok(),
    `${url} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`,
  ).toBe(true);
  return (await res.json()) as T;
}

interface Seed {
  projectId: number;
  contractorId: number;
  devisId: number;
  certId: number;
  lotId: number;
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM certificats WHERE id = $1", [s.certId]],
    ["DELETE FROM devis_translations WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM lots WHERE id = $1", [s.lotId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[unsent-cert cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Unsent certificats — dashboard alert + devis panel (task #539)", () => {
  test("dashboard card, dialog row, and devis certificat section appear", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-unsent-cert-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let s: Seed | null = null;

    try {
      const api = context.request;
      const login = await api.post("/api/auth/dev-login", { data: { email } });
      expect(login.ok(), `dev-login failed (${login.status()})`).toBe(true);

      const project = await postOk<{ id: number }>(api, "/api/projects", {
        name: `UnsentCert ${uniq}`,
        code: `UC-${uniq}`,
        clientName: "Unsent Cert Client",
      });
      const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
        name: `UnsentCert Co ${uniq}`,
      });
      const lot = await postOk<{ id: number }>(api, `/api/projects/${project.id}/lots`, {
        lotNumber: "01",
        descriptionFr: "Plomberie",
        descriptionUk: "Plumbing",
      });
      const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
        contractorId: contractor.id,
        devisCode: `UC-DEV-${uniq}`,
        descriptionFr: "Travaux de plomberie",
        descriptionUk: "Plumbing works",
        amountHt: "1000.00",
        amountTtc: "1200.00",
        invoicingMode: "mode_b",
        lotId: lot.id,
      });
      const cert = await postOk<{ id: number; certificateRef: string }>(
        api,
        `/api/projects/${project.id}/certificats`,
        {
          contractorId: contractor.id,
          totalWorksHt: "1000.00",
          pvMvAdjustment: "0.00",
          previousPayments: "0.00",
          retenueGarantie: "0.00",
          netToPayHt: "1000.00",
          tvaAmount: "200.00",
          netToPayTtc: "1200.00",
          status: "ready",
        },
      );
      // Signed-off devis so the panel's stage gate passes.
      await db.query(
        `UPDATE devis SET sign_off_stage = 'client_signed_off' WHERE id = $1`,
        [devis.id],
      );
      s = { projectId: project.id, contractorId: contractor.id, devisId: devis.id, certId: cert.id, lotId: lot.id };

      const page = await context.newPage();

      // ── 1+2. Dashboard card and dialog ──────────────────────────────────
      await page.goto("/");
      await expect(page.getByTestId("card-unsent-certificats")).toBeVisible();
      await page.getByTestId("card-unsent-certificats").click();
      await expect(page.getByTestId("dialog-unsent-certificats")).toBeVisible();
      const row = page.getByTestId(`row-unsent-certificat-${cert.id}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(`UnsentCert ${uniq}`);
      await expect(row).toContainText(`UnsentCert Co ${uniq}`);
      await expect(page.getByTestId(`button-send-unsent-certificat-${cert.id}`)).toBeVisible();
      await page.keyboard.press("Escape");

      // ── 3. Devis certificat section ─────────────────────────────────────
      await page.goto(`/projets/${project.id}`);
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${devis.id}`).click();
      await expect(page.getByTestId(`panel-certificat-${devis.id}`)).toBeVisible();
      await expect(page.getByTestId(`row-devis-certificat-${cert.id}`)).toBeVisible();
      await expect(page.getByTestId(`button-devis-send-cert-${cert.id}`)).toBeVisible();
    } finally {
      await cleanup(db, s);
      await db.end();
      await context.close();
    }
  });
});
