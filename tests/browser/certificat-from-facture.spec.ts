import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the "Créer le certificat" button on the Factures tab
 * (task #497 — verifying the task #496 UI flow).
 *
 * Verifies:
 *   1. Clicking `button-create-certificat-facture-<id>` on an eligible invoice
 *      card opens the read-only confirmation dialog.
 *   2. The dialog shows server-derived figures: `text-preview-total-works` and
 *      `text-preview-net-ht` are visible and non-empty.
 *   3. Confirming (`button-confirm-create-certificat`) fires the POST, shows a
 *      success toast, and the card now shows `badge-certified-facture-<id>`.
 *   4. The button is gone after certification.
 *   5. Clicking the badge navigates to `/certificats?projectId=<id>`.
 *
 * Seeds: project → contractor → marche → devis → invoice (all via direct pg
 * because there is no public API for marches, and exact field control is
 * needed). Cleans up in finally regardless of outcome.
 *
 * Requires NODE_ENV=development, ENABLE_DEV_LOGIN_FOR_E2E=true, and
 * DATABASE_URL for seeding + cleanup.
 */

const SEED_PREFIX = "e2e-cert-facture-";

interface Seeded {
  projectId: number;
  contractorId: number;
  marcheId: number;
  devisId: number;
  invoiceId: number;
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const projRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [
      `${SEED_PREFIX}project-${uniq}`,
      `${SEED_PREFIX}${uniq}`,
      "E2E Test Client",
    ],
  );
  const projectId = projRes.rows[0].id;

  const ctorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`],
  );
  const contractorId = ctorRes.rows[0].id;

  // A marché is required for the certificat-preview to compute retenue de
  // garantie (retenueGarantiePercent).
  const marcheRes = await db.query<{ id: number }>(
    `INSERT INTO marches
       (project_id, contractor_id, total_ht, total_ttc, retenue_garantie_percent, status)
     VALUES ($1, $2, '10000.00', '12000.00', '5.00', 'active') RETURNING id`,
    [projectId, contractorId],
  );
  const marcheId = marcheRes.rows[0].id;

  // A confirmed, client-signed devis is the prerequisite for an invoice and
  // for the certificat-preview route to accept it.
  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr,
        amount_ht, amount_ttc, status, sign_off_stage)
     VALUES ($1, $2, $3, 'E2E test devis',
             '8000.00', '9600.00', 'confirmed', 'client_signed_off')
     RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D-${uniq}`],
  );
  const devisId = devisRes.rows[0].id;

  // A confirmed (non-void, non-acompte) invoice triggers the button.
  const invRes = await db.query<{ id: number }>(
    `INSERT INTO invoices
       (devis_id, contractor_id, project_id,
        invoice_number, amount_ht, tva_amount, amount_ttc, status)
     VALUES ($1, $2, $3, $4, '8000.00', '1600.00', '9600.00', 'pending')
     RETURNING id`,
    [devisId, contractorId, projectId, `${SEED_PREFIX}INV-${uniq}`],
  );
  const invoiceId = invRes.rows[0].id;

  return { projectId, contractorId, marcheId, devisId, invoiceId };
}

async function cleanup(db: Client, s: Seeded | null): Promise<void> {
  if (!s) return;
  // certificat_sources and certificats are scoped to projectId via FK;
  // delete them before removing the project.
  await db
    .query(
      `DELETE FROM certificat_sources
       WHERE certificat_id IN (SELECT id FROM certificats WHERE project_id = $1)`,
      [s.projectId],
    )
    .catch((e: Error) =>
      console.warn("[cert-facture cleanup] certificat_sources:", e.message),
    );
  await db
    .query(`DELETE FROM certificats WHERE project_id = $1`, [s.projectId])
    .catch((e: Error) =>
      console.warn("[cert-facture cleanup] certificats:", e.message),
    );
  // marches, devis, and invoices all cascade from projects.
  await db
    .query(`DELETE FROM projects WHERE id = $1`, [s.projectId])
    .catch((e: Error) =>
      console.warn("[cert-facture cleanup] projects:", e.message),
    );
  await db
    .query(`DELETE FROM contractors WHERE id = $1`, [s.contractorId])
    .catch((e: Error) =>
      console.warn("[cert-facture cleanup] contractors:", e.message),
    );
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

test.describe("Factures tab — Créer le certificat button (task #497)", () => {
  test(
    "button opens read-only dialog, confirm creates cert, badge replaces button, badge navigates to /certificats",
    async ({ browser }) => {
      const databaseUrl = process.env.DATABASE_URL;
      expect(
        databaseUrl,
        "DATABASE_URL must be set for this test",
      ).toBeTruthy();

      const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const email = `${SEED_PREFIX}${uniq}@local.test`;
      const db = new Client({ connectionString: databaseUrl! });
      await db.connect();

      const context = await browser.newContext({
        viewport: { width: 1600, height: 900 },
      });
      let s: Seeded | null = null;

      try {
        await devLogin(context.request, email);
        s = await seed(db, uniq);

        const page = await context.newPage();
        await page.goto(`/projets/${s.projectId}?tab=factures`);

        // ── 1. The "Créer le certificat" button is visible on the invoice card ──
        const createBtn = page.getByTestId(
          `button-create-certificat-facture-${s.invoiceId}`,
        );
        await expect(createBtn).toBeVisible({ timeout: 15_000 });

        // ── 2. Clicking opens the read-only confirmation dialog ────────────────
        await createBtn.click();

        const dialog = page.getByTestId("dialog-create-certificat");
        await expect(dialog).toBeVisible({ timeout: 8_000 });

        // Preview figures derived server-side must be rendered (non-empty).
        const totalWorks = page.getByTestId("text-preview-total-works");
        const netHt = page.getByTestId("text-preview-net-ht");

        await expect(totalWorks).toBeVisible({ timeout: 8_000 });
        await expect(netHt).toBeVisible({ timeout: 8_000 });

        // Sanity: each row should contain at least a numeric digit.
        await expect(totalWorks).toContainText(/\d/);
        await expect(netHt).toContainText(/\d/);

        // ── 3. Confirming fires the POST and shows a success toast ─────────────
        const confirmBtn = page.getByTestId("button-confirm-create-certificat");
        await expect(confirmBtn).toBeEnabled({ timeout: 5_000 });
        await confirmBtn.click();

        // Toast title: "Certificat <ref> créé"
        await expect(page.getByText(/créé/i).first()).toBeVisible({
          timeout: 8_000,
        });

        // ── 4. The dialog closes and the badge replaces the button ─────────────
        await expect(dialog).toHaveCount(0, { timeout: 10_000 });

        const badge = page.getByTestId(
          `badge-certified-facture-${s.invoiceId}`,
        );
        await expect(badge).toBeVisible({ timeout: 10_000 });

        // The create button must be gone now.
        await expect(createBtn).toHaveCount(0);

        // ── 5. Badge click navigates to /certificats?projectId=<id> ───────────
        await badge.click();

        await page.waitForURL(
          (url) =>
            url.pathname === "/certificats" &&
            url.searchParams.get("projectId") === String(s!.projectId),
          { timeout: 8_000 },
        );
        expect(page.url()).toContain(`projectId=${s.projectId}`);
      } finally {
        try {
          await cleanup(db, s);
        } finally {
          await db.end();
          await context.close();
        }
      }
    },
  );
});
