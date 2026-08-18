import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * Task #618 — the Honoraires page must tell the same story as the
 * design-contract card for a milestone-billed project:
 *   - Milestone breakdown card renders (same phases/amounts/statuses).
 *   - The legacy conception mirror fee shows "Covered by design contract"
 *     instead of Unassigned/PENDING badges.
 *   - The "Total Invoiced (Penny Lane)" tile counts milestone invoicing
 *     (non-zero when a milestone is invoiced).
 *
 * Seeds a project with a design contract (3 600 € TTC / 3 000 € HT),
 * three milestones (one invoiced, one reached, one pending) and a legacy
 * conception fee row mirroring the contract with no entries.
 */

const SEED_PREFIX = "e2e-fees-milestone-";

async function devLogin(api: {
  post: (url: string, opts: { data: unknown }) => Promise<{ ok: () => boolean; status: () => number }>;
}) {
  const res = await api.post("/api/auth/dev-login", { data: { email: "e2e-fees-milestone@renosud.com" } });
  expect(res.ok(), `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`).toBe(true);
}

interface Seeded {
  projectId: number;
  projectCode: string;
  feeId: number;
  manualFeeId: number;
  invoicedMilestoneId: number;
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const projectCode = `${SEED_PREFIX}${uniq}`;
  const projectRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name) VALUES ($1, $2, $3) RETURNING id`,
    [`${SEED_PREFIX}project-${uniq}`, projectCode, "Milestone Client"],
  );
  const projectId = projectRes.rows[0].id;

  const contractRes = await db.query<{ id: number }>(
    `INSERT INTO design_contracts
       (project_id, storage_key, original_filename, total_ttc, total_ht, total_tva, tva_rate,
        conception_amount_ht, planning_amount_ht)
     VALUES ($1, $2, 'contrat-e2e.pdf', 3600.00, 3000.00, 600.00, 20.00, 2000.00, 1000.00)
     RETURNING id`,
    [projectId, `design-contracts/${projectId}/active/e2e-${uniq}.pdf`],
  );
  const contractId = contractRes.rows[0].id;

  const msRes = await db.query<{ id: number }>(
    `INSERT INTO design_contract_milestones
       (contract_id, sequence, label_fr, percentage, amount_ttc, trigger_event, status, reached_at, invoiced_at)
     VALUES
       ($1, 1, 'Ouverture du dossier', 30.00, 1080.00, 'file_opened', 'invoiced', now(), now()),
       ($1, 2, 'Signature du concept', 40.00, 1440.00, 'concept_signed', 'reached', now(), NULL),
       ($1, 3, 'Plans définitifs signés', 30.00, 1080.00, 'final_plans_signed', 'pending', NULL, NULL)
     RETURNING id`,
    [contractId],
  );
  const invoicedMilestoneId = msRes.rows[0].id;

  // Legacy mirror fee: conception, amount equals the contract's
  // conception_amount_ht (that's what the contract-confirm reconciliation
  // writes), no phase, default pending status, no entries.
  const feeRes = await db.query<{ id: number }>(
    `INSERT INTO fees (project_id, fee_type, fee_amount_ht, invoiced_amount, remaining_amount, status)
     VALUES ($1, 'conception', 2000.00, 0.00, 2000.00, 'pending') RETURNING id`,
    [projectId],
  );

  // Manually-added conception fee with a DIFFERENT amount — a real fee,
  // NOT a contract mirror. Must keep its badges and count in totals.
  const manualFeeRes = await db.query<{ id: number }>(
    `INSERT INTO fees (project_id, fee_type, fee_amount_ht, invoiced_amount, remaining_amount, status)
     VALUES ($1, 'conception', 500.00, 100.00, 400.00, 'active') RETURNING id`,
    [projectId],
  );

  return {
    projectId,
    projectCode,
    feeId: feeRes.rows[0].id,
    manualFeeId: manualFeeRes.rows[0].id,
    invoicedMilestoneId,
  };
}

async function cleanup(db: Client) {
  await db.query(
    `DELETE FROM projects WHERE code LIKE $1`,
    [`${SEED_PREFIX}%`],
  );
}

test.describe("Honoraires page — milestone-billed project", () => {
  let db: Client;
  let seeded: Seeded;

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await cleanup(db);
    seeded = await seed(db, `${Date.now()}`);
  });

  test.afterAll(async () => {
    await cleanup(db);
    await db.end();
  });

  test("shows milestone breakdown, covered badge, and non-zero invoiced tile", async ({ page, request }) => {
    await devLogin(request);
    // Share the authenticated session with the page context.
    const cookies = await request.storageState();
    await page.context().addCookies(cookies.cookies);

    await page.goto("/honoraires");
    await expect(page.getByTestId("text-page-title")).toBeVisible();

    // Select the seeded project.
    await page.getByTestId("select-fee-project-filter").click();
    await page.getByRole("option", { name: new RegExp(seeded.projectCode) }).click();

    // Milestone breakdown card mirrors the design-contract card.
    const card = page.getByTestId("card-design-contract-milestones");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("badge-milestone-billed")).toBeVisible();
    await expect(card.getByTestId("text-contract-total-ttc")).toContainText("3");
    await expect(card).toContainText("Ouverture du dossier");
    await expect(card).toContainText("Signature du concept");
    await expect(card).toContainText("Plans définitifs signés");
    await expect(card.getByTestId(`badge-fee-milestone-status-${seeded.invoicedMilestoneId}`)).toHaveText("Invoiced");

    // Milestone summary: invoiced 1080 TTC, remaining 2520 TTC.
    await expect(card.getByTestId("text-contract-invoiced-ttc")).toContainText("1");
    await expect(card.getByTestId("text-contract-remaining-ttc")).toContainText("2");

    // Legacy mirror fee: covered badge, no Unassigned / PENDING badges.
    const feeCard = page.getByTestId(`card-fee-${seeded.feeId}`);
    await expect(feeCard).toBeVisible();
    await expect(feeCard.getByTestId(`badge-covered-by-contract-${seeded.feeId}`)).toBeVisible();
    await expect(feeCard.getByTestId("badge-phase-unassigned")).toHaveCount(0);
    await expect(feeCard).not.toContainText(/pending/i);

    // The MANUAL conception fee (different amount from the contract's
    // conception component) is NOT a mirror: keeps its normal badges and
    // counts in the totals.
    const manualCard = page.getByTestId(`card-fee-${seeded.manualFeeId}`);
    await expect(manualCard).toBeVisible();
    await expect(manualCard.getByTestId(`badge-covered-by-contract-${seeded.manualFeeId}`)).toHaveCount(0);
    await expect(manualCard.getByTestId("badge-phase-unassigned")).toBeVisible();

    // Invoiced tile counts milestone invoicing (900 HT) PLUS the manual
    // fee's invoiced 100 HT = 1 000 HT.
    const invoicedTile = page.getByTestId("text-total-invoiced");
    await expect(invoicedTile).toContainText("1 000,00");

    // Total Honoraires: contract 3 000 HT + manual fee 500 HT = 3 500 HT
    // (the mirror row is replaced by the contract figure, not added).
    await expect(page.getByTestId("text-total-earned")).toContainText("3 500,00");
  });

  test("TTC-only contract (no HT / no TVA): tiles show TTC and never fabricate HT", async ({ page, request }) => {
    // Seed a second project whose contract carries neither total_ht nor
    // tva_rate — HT is unknown and must NOT be derived from a guessed rate.
    const uniq = `ttconly-${Date.now()}`;
    const projectCode = `${SEED_PREFIX}${uniq}`;
    const projectRes = await db.query<{ id: number }>(
      `INSERT INTO projects (name, code, client_name) VALUES ($1, $2, 'TTC Only Client') RETURNING id`,
      [`${SEED_PREFIX}project-${uniq}`, projectCode],
    );
    const projectId = projectRes.rows[0].id;
    const contractRes = await db.query<{ id: number }>(
      `INSERT INTO design_contracts (project_id, storage_key, original_filename, total_ttc)
       VALUES ($1, $2, 'contrat-ttc-only.pdf', 3600.00) RETURNING id`,
      [projectId, `design-contracts/${projectId}/active/e2e-${uniq}.pdf`],
    );
    await db.query(
      `INSERT INTO design_contract_milestones
         (contract_id, sequence, label_fr, percentage, amount_ttc, trigger_event, status, reached_at, invoiced_at)
       VALUES ($1, 1, 'Ouverture du dossier', 50.00, 1800.00, 'file_opened', 'invoiced', now(), now()),
              ($1, 2, 'Plans définitifs signés', 50.00, 1800.00, 'final_plans_signed', 'pending', NULL, NULL)`,
      [contractRes.rows[0].id],
    );

    await devLogin(request);
    const cookies = await request.storageState();
    await page.context().addCookies(cookies.cookies);

    await page.goto("/honoraires");
    await page.getByTestId("select-fee-project-filter").click();
    await page.getByRole("option", { name: new RegExp(projectCode) }).click();

    // Milestone card renders TTC figures; HT lines are absent (unknown).
    const card = page.getByTestId("card-design-contract-milestones");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("text-contract-total-ttc")).toContainText("3");
    await expect(card.getByTestId("text-contract-total-ht")).toHaveCount(0);
    await expect(card.getByTestId("text-contract-invoiced-ht")).toHaveCount(0);

    // Tiles: primary figure is TTC, with an explicit "HT unavailable" note —
    // no fabricated 20% HT anywhere.
    await expect(page.getByTestId("text-total-invoiced")).toContainText("1 800,00");
    await expect(page.getByTestId("text-total-invoiced")).toContainText("TTC");
    await expect(page.getByTestId("text-total-invoiced-ht-unknown")).toBeVisible();
    await expect(page.getByTestId("text-total-earned")).toContainText("3 600,00");
    await expect(page.getByTestId("text-total-earned-ht-unknown")).toBeVisible();
    await expect(page.getByTestId("text-total-remaining")).toContainText("1 800,00");
    await expect(page.getByTestId("text-total-remaining-ht-unknown")).toBeVisible();
  });
});
