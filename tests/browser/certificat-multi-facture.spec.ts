import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for multi-facture certificats (grouped certificat de paiement).
 *
 * Verifies:
 *   1. Eligible invoice cards show a selection checkbox; selecting two same-
 *      contractor invoices reveals the selection bar with the correct count.
 *   2. "Certificat groupé" opens the grouped read-only dialog with server-
 *      derived figures (per-facture claims + combined totals).
 *   3. Confirming creates ONE certificat; both cards show the SAME certified
 *      badge ref; DB holds exactly one certificat with two certificat_sources
 *      invoice rows.
 *   4. API: a mixed-TVA selection is refused with 409 TVA_MIXED.
 *
 * Seeds via direct pg; cleans up in finally. Requires NODE_ENV=development,
 * ENABLE_DEV_LOGIN_FOR_E2E=true, DATABASE_URL.
 */

const SEED_PREFIX = "e2e-cert-multi-";

interface Seeded {
  projectId: number;
  contractorId: number;
  devisId: number;
  invoiceIds: number[]; // [inv20a, inv20b, inv10mixed]
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const projRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, status)
     VALUES ($1, $2, 'E2E Test Client', 'active') RETURNING id`,
    [`${SEED_PREFIX}project-${uniq}`, `${SEED_PREFIX}${uniq}`],
  );
  const projectId = projRes.rows[0].id;

  const ctorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`],
  );
  const contractorId = ctorRes.rows[0].id;

  await db.query(
    `INSERT INTO marches
       (project_id, contractor_id, total_ht, total_ttc, retenue_garantie_percent, status)
     VALUES ($1, $2, '20000.00', '24000.00', '5.00', 'active')`,
    [projectId, contractorId],
  );

  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr,
        amount_ht, amount_ttc, status, sign_off_stage)
     VALUES ($1, $2, $3, 'E2E multi test devis',
             '15000.00', '18000.00', 'confirmed', 'client_signed_off')
     RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D-${uniq}`],
  );
  const devisId = devisRes.rows[0].id;

  const invoiceIds: number[] = [];
  const rows: Array<[string, string, string, string]> = [
    // [number suffix, ht, tva, ttc] — two at 20%, one at 10% (mixed offender)
    ["A", "2000.00", "400.00", "2400.00"],
    ["B", "3000.00", "600.00", "3600.00"],
    ["C", "1000.00", "100.00", "1100.00"],
  ];
  for (const [sfx, ht, tva, ttc] of rows) {
    const invRes = await db.query<{ id: number }>(
      `INSERT INTO invoices
         (devis_id, contractor_id, project_id,
          invoice_number, amount_ht, tva_amount, amount_ttc, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id`,
      [devisId, contractorId, projectId, `${SEED_PREFIX}INV-${sfx}-${uniq}`, ht, tva, ttc],
    );
    invoiceIds.push(invRes.rows[0].id);
  }

  return { projectId, contractorId, devisId, invoiceIds };
}

async function cleanup(db: Client, s: Seeded | null): Promise<void> {
  if (!s) return;
  await db
    .query(
      `DELETE FROM certificat_sources
       WHERE certificat_id IN (SELECT id FROM certificats WHERE project_id = $1)`,
      [s.projectId],
    )
    .catch((e: Error) => console.warn("[cert-multi cleanup] certificat_sources:", e.message));
  await db
    .query(`DELETE FROM certificats WHERE project_id = $1`, [s.projectId])
    .catch((e: Error) => console.warn("[cert-multi cleanup] certificats:", e.message));
  await db
    .query(`DELETE FROM projects WHERE id = $1`, [s.projectId])
    .catch((e: Error) => console.warn("[cert-multi cleanup] projects:", e.message));
  await db
    .query(`DELETE FROM contractors WHERE id = $1`, [s.contractorId])
    .catch((e: Error) => console.warn("[cert-multi cleanup] contractors:", e.message));
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`).toBe(true);
}

test.describe("Multi-facture certificats — grouped creation", () => {
  test("select 2 factures → grouped dialog → one cert with 2 source rows; mixed TVA refused via API", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `${SEED_PREFIX}${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    let s: Seeded | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(db, uniq);
      const [invA, invB, invC] = s.invoiceIds;

      // ── 4 (API first, read-only): mixed-TVA selection refused ─────────────
      const mixedRes = await context.request.post(
        `/api/projects/${s.projectId}/certificats/from-invoices`,
        { data: { invoiceIds: [invA, invC] } },
      );
      expect(mixedRes.status()).toBe(409);
      const mixedBody = await mixedRes.json();
      expect(mixedBody.code).toBe("TVA_MIXED");

      const page = await context.newPage();
      await page.goto(`/projets/${s.projectId}?tab=factures`);

      // ── 1. Checkboxes visible; select the two 20% invoices ────────────────
      const cbA = page.getByTestId(`checkbox-select-facture-${invA}`);
      const cbB = page.getByTestId(`checkbox-select-facture-${invB}`);
      await expect(cbA).toBeVisible({ timeout: 15_000 });
      await cbA.check();
      await cbB.check();

      const bar = page.getByTestId("bar-certificat-selection");
      await expect(bar).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId("text-certificat-selection-count")).toHaveText("2");

      // ── 2. Grouped dialog with server-derived figures ──────────────────────
      await page.getByTestId("button-create-certificat-multi").click();
      const dialog = page.getByTestId("dialog-create-certificat-multi");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      await expect(page.getByTestId(`text-preview-multi-claim-${invA}`)).toBeVisible({ timeout: 8_000 });
      await expect(page.getByTestId(`text-preview-multi-claim-${invB}`)).toBeVisible();
      await expect(page.getByTestId("text-preview-multi-total-works")).toContainText(/\d/);
      await expect(page.getByTestId("text-preview-multi-net-ht")).toContainText(/\d/);
      // Combined period claim = 2000 + 3000 = 5000
      await expect(page.getByTestId("text-preview-multi-period")).toContainText(/5[\s\u202f\u00a0.,]?000/);

      // ── 3. Confirm creates ONE cert; both cards badge with the same ref ───
      const confirmBtn = page.getByTestId("button-confirm-create-certificat-multi");
      await expect(confirmBtn).toBeEnabled({ timeout: 5_000 });
      await confirmBtn.click();
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });

      const badgeA = page.getByTestId(`badge-certified-facture-${invA}`);
      const badgeB = page.getByTestId(`badge-certified-facture-${invB}`);
      await expect(badgeA).toBeVisible({ timeout: 10_000 });
      await expect(badgeB).toBeVisible({ timeout: 10_000 });
      const refA = (await badgeA.innerText()).replace(/^.*—\s*/, "").trim();
      const refB = (await badgeB.innerText()).replace(/^.*—\s*/, "").trim();
      expect(refA).toBe(refB);

      // DB: exactly one certificat, with exactly the two invoice source rows.
      const certRows = await db.query<{ id: number }>(
        `SELECT id FROM certificats WHERE project_id = $1 AND status != 'superseded'`,
        [s.projectId],
      );
      expect(certRows.rows.length).toBe(1);
      const srcRows = await db.query<{ invoice_id: number }>(
        `SELECT invoice_id FROM certificat_sources WHERE certificat_id = $1 ORDER BY invoice_id`,
        [certRows.rows[0].id],
      );
      expect(srcRows.rows.map((r) => r.invoice_id)).toEqual([invA, invB].sort((a, b) => a - b));
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
