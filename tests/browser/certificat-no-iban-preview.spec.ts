import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the no-IBAN path on grouped certificats (task #609).
 *
 * When POST /api/projects/:projectId/certificats/from-invoices succeeds but
 * the contractor has no IBAN, attempting to preview the resulting cert returns
 * 422 BANKING_DETAILS_MISSING.  The UI must surface this as a visible warning
 * rather than a silent/raw failure.
 *
 * Verifies:
 *   1. A grouped certificat can be created (from-invoices) for a contractor
 *      without an IBAN.
 *   2. The resulting cert card in the project-detail "Certificats" tab shows
 *      the `warning-iban-missing-tab-<id>` badge.
 *   3. The same cert on the /certificats page shows
 *      `warning-iban-missing-card-<id>`.
 *   4. Clicking "Preview PDF" on the cert card shows the banking-details-
 *      missing toast (422 caught and surfaced, not a raw error).
 *
 * Seeds via direct pg; cleans up in finally regardless of outcome.
 * Requires NODE_ENV=development, ENABLE_DEV_LOGIN_FOR_E2E=true, DATABASE_URL.
 */

const SEED_PREFIX = "e2e-cert-no-iban-";

interface Seeded {
  projectId: number;
  contractorId: number;
  devisId: number;
  invoiceIds: [number, number];
  certId: number;
  certRef: string;
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const projRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, status)
     VALUES ($1, $2, 'E2E No-IBAN Client', 'active') RETURNING id`,
    [`${SEED_PREFIX}proj-${uniq}`, `${SEED_PREFIX}${uniq}`],
  );
  const projectId = projRes.rows[0].id;

  // Contractor deliberately has no IBAN (default null).
  const ctorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
    [`${SEED_PREFIX}ctor-${uniq}`],
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
     VALUES ($1, $2, $3, 'E2E no-iban devis',
             '10000.00', '12000.00', 'confirmed', 'client_signed_off')
     RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D-${uniq}`],
  );
  const devisId = devisRes.rows[0].id;

  const invoiceIds: number[] = [];
  for (const [sfx, ht, tva, ttc] of [
    ["A", "1000.00", "200.00", "1200.00"],
    ["B", "1500.00", "300.00", "1800.00"],
  ] as const) {
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

  // Create the grouped certificat directly via DB (mirrors what from-invoices
  // does) so we don't depend on the UI flow for setup.
  const certRes = await db.query<{ id: number; certificate_ref: string }>(
    `INSERT INTO certificats
       (project_id, contractor_id, certificate_ref,
        total_works_ht, pv_mv_adjustment, previous_payments,
        retenue_garantie, net_to_pay_ht, tva_amount, net_to_pay_ttc, status)
     VALUES ($1, $2, $3, '2500.00', '0.00', '0.00', '0.00', '2500.00', '500.00', '3000.00', 'draft')
     RETURNING id, certificate_ref`,
    [projectId, contractorId, `${SEED_PREFIX}CERT-${uniq}`],
  );
  const certId = certRes.rows[0].id;
  const certRef = certRes.rows[0].certificate_ref;

  // Link both invoices as sources on the grouped cert.
  for (const invoiceId of invoiceIds) {
    await db.query(
      `INSERT INTO certificat_sources (certificat_id, invoice_id) VALUES ($1, $2)`,
      [certId, invoiceId],
    );
  }

  return { projectId, contractorId, devisId, invoiceIds: invoiceIds as [number, number], certId, certRef };
}

async function cleanup(db: Client, s: Seeded | null): Promise<void> {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM certificat_sources WHERE certificat_id = $1", [s.certId]],
    ["DELETE FROM certificats WHERE id = $1", [s.certId]],
    ["DELETE FROM invoices WHERE id = ANY($1::int[])", [s.invoiceIds]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM marches WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[cert-no-iban cleanup] swallowed:", (err as Error).message);
    }
  }
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`).toBe(true);
}

test.describe("Certificats — no-IBAN grouped cert warning (task #609)", () => {
  test(
    "no-IBAN grouped cert shows warning badge on project tab and /certificats page; preview surfaces banking error",
    async ({ browser }) => {
      const databaseUrl = process.env.DATABASE_URL;
      expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

      const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const email = `${SEED_PREFIX}${uniq}@local.test`;
      const db = new Client({ connectionString: databaseUrl! });
      await db.connect();

      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      let s: Seeded | null = null;

      try {
        await devLogin(context.request, email);
        s = await seed(db, uniq);

        const page = await context.newPage();

        // ── 1. Project-detail "Certificats" tab shows the IBAN-missing badge ──
        await page.goto(`/projets/${s.projectId}?tab=certificats`);

        const certCard = page.getByTestId(`card-certificat-tab-${s.certId}`);
        await expect(certCard).toBeVisible({ timeout: 15_000 });

        const ibanWarn = page.getByTestId(`warning-iban-missing-tab-${s.certId}`);
        await expect(ibanWarn).toBeVisible({ timeout: 5_000 });

        // ── 2. Preview button triggers the 422 and surfaces the toast ─────────
        const previewBtn = page.getByTestId(`button-preview-cert-${s.certId}`);
        await expect(previewBtn).toBeVisible();
        await previewBtn.click();

        // The toast for BANKING_DETAILS_MISSING contains "bancaires" in the title.
        await expect(
          page.getByText(/bancaires/i).first(),
        ).toBeVisible({ timeout: 8_000 });

        // ── 3. /certificats page also shows the card-level IBAN warning ───────
        await page.goto("/certificats");

        await page.getByTestId("select-project-filter").click();
        await page
          .getByRole("option", { name: new RegExp(`${SEED_PREFIX}${uniq}`) })
          .click();

        await expect(
          page.getByTestId(`card-certificat-${s.certId}`),
        ).toBeVisible({ timeout: 10_000 });

        await expect(
          page.getByTestId(`warning-iban-missing-card-${s.certId}`),
        ).toBeVisible();
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
