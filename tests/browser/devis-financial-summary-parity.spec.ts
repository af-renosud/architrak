import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

function normaliseMoney(text: string): string {
  return text.replace(/\s/g, "");
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()})`).toBe(true);
}

test("quotation detail matches dashboard when certified includes a no-invoice opening deposit", async ({ browser }) => {
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const uniq = Date.now().toString(36);
  let projectId: number | null = null;
  let contractorId: number | null = null;
  let devisId: number | null = null;
  let certificatId: number | null = null;

  try {
    const project = await db.query<{ id: number }>(
      `INSERT INTO projects (name, code, client_name, status)
       VALUES ($1, $2, 'Financial parity client', 'active') RETURNING id`,
      [`e2e-financial-parity-${uniq}`, `PAR-${uniq}`],
    );
    projectId = project.rows[0].id;

    const contractor = await db.query<{ id: number }>(
      `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
      [`e2e-financial-parity-contractor-${uniq}`],
    );
    contractorId = contractor.rows[0].id;

    const devis = await db.query<{ id: number }>(
      `INSERT INTO devis
         (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc,
          status, accounting_state, sign_off_stage, acompte_required, acompte_amount_ht,
          acompte_state, acompte_paid_via)
       VALUES ($1, $2, $3, 'Topographic survey', '2075.00', '2490.00',
               'confirmed', 'active', 'client_signed_off', true, '1240.00',
               'paid', 'certificat_no_invoice')
       RETURNING id`,
      [projectId, contractorId, `PAR.1.${uniq}`],
    );
    devisId = devis.rows[0].id;

    const certificat = await db.query<{ id: number }>(
      `INSERT INTO certificats
         (project_id, contractor_id, certificate_ref, date_issued, total_works_ht,
          pv_mv_adjustment, previous_payments, retenue_garantie,
          cumulative_prorata_deduction, period_prorata_deduction,
          cumulative_acompte_recoupment, period_acompte_recoupment,
          tva_rate_percent, tva_autoliquidation, tva_rate_source,
          net_to_pay_ht, tva_amount, net_to_pay_ttc, status, acompte_devis_id)
       VALUES ($1, $2, $3, CURRENT_DATE, '1240.00',
               '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00',
               '20.00', false, 'documentary', '1240.00', '248.00', '1488.00',
               'draft', $4)
       RETURNING id`,
      [projectId, contractorId, `C-PAR-${uniq}`, devisId],
    );
    certificatId = certificat.rows[0].id;

    await devLogin(context.request, `financial-parity-${uniq}@local.test`);
    const page = await context.newPage();
    await page.goto(`/projets/${projectId}`);

    await page.getByTestId("tab-resume").click();
    const dashboardRow = page.getByTestId(`card-devis-summary-${devisId}`);
    await expect(dashboardRow).toBeVisible();
    let dashboardCertified = dashboardRow.getByText("Certified").locator("..");
    let dashboardRemaining = dashboardRow.getByText("Remaining").locator("..");
    expect(normaliseMoney(await dashboardCertified.innerText())).toContain("0,00€TTC");
    expect(normaliseMoney(await dashboardRemaining.innerText())).toContain("2490,00€TTC");

    await page.getByTestId("tab-devis").click();
    await page.getByTestId(`row-devis-toggle-${devisId}`).click();
    expect(normaliseMoney(await page.getByTestId(`text-devis-detail-certified-${devisId}`).innerText())).toBe("0,00€TTC");
    expect(normaliseMoney(await page.getByTestId(`text-devis-detail-remaining-${devisId}`).innerText())).toBe("2490,00€TTC");

    await page.getByTestId("tab-certificats").click();
    await page.getByTestId(`button-advance-cert-tab-${certificatId}`).click();
    await expect(page.getByTestId(`card-certificat-tab-${certificatId}`).getByText("READY", { exact: true })).toBeVisible();

    await page.getByTestId("tab-resume").click();
    await expect.poll(async () => normaliseMoney(await dashboardCertified.innerText())).toContain("1488,00€TTC");
    dashboardCertified = dashboardRow.getByText("Certified").locator("..");
    dashboardRemaining = dashboardRow.getByText("Remaining").locator("..");
    expect(normaliseMoney(await dashboardCertified.innerText())).toContain("1488,00€TTC");
    expect(normaliseMoney(await dashboardRemaining.innerText())).toContain("1002,00€TTC");

    await page.getByTestId("tab-devis").click();
    await page.getByTestId(`row-devis-toggle-${devisId}`).click();
    const detail = page.getByTestId(`card-devis-detail-financial-${devisId}`);
    await expect(detail).toBeVisible();
    await expect(detail.getByText("Certified", { exact: true })).toBeVisible();
    await expect(detail.getByText("Invoiced", { exact: true })).toHaveCount(0);

    const detailCertified = page.getByTestId(`text-devis-detail-certified-${devisId}`);
    const detailRemaining = page.getByTestId(`text-devis-detail-remaining-${devisId}`);
    expect(normaliseMoney(await detailCertified.innerText())).toBe("1488,00€TTC");
    expect(normaliseMoney(await detailRemaining.innerText())).toBe("1002,00€TTC");
    await expect(page.getByTestId(`text-devis-detail-acompte-${devisId}`)).toContainText("Includes opening deposit");
    await expect(detail).toContainText("0 supplier invoices");
  } finally {
    await context.close();
    if (certificatId) await db.query("DELETE FROM certificats WHERE id = $1", [certificatId]).catch(() => {});
    if (devisId) await db.query("DELETE FROM devis WHERE id = $1", [devisId]).catch(() => {});
    if (projectId) await db.query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => {});
    if (contractorId) await db.query("DELETE FROM contractors WHERE id = $1", [contractorId]).catch(() => {});
    await db.end();
  }
});