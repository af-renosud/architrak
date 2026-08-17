import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for TTC figures on the Financial Tracking and Honoraires
 * pages (Task #580).
 *
 * Task #576 added TTC display to both pages. This spec verifies that:
 *
 * Financial Tracking (/suivi-financier):
 *   - The contracted column shows €12,000.00 TTC (devis amount_ttc = 12 000).
 *   - The certified column shows €0.00 TTC (no certificats on the fresh devis).
 *   - The remaining column shows €12,000.00 TTC (= contracted − certified).
 *
 * Honoraires (/honoraires):
 *   - After selecting the seeded project the three summary cards show:
 *       Total Honoraires  → €6,000.00 TTC (5 000 HT × 1.20)
 *       Total Invoiced    → €0.00 TTC
 *       Remaining         → €6,000.00 TTC
 *   - The Conception phase summary card shows €6,000.00 TTC.
 *
 * REQUIRES the server to be booted with:
 *   - ENABLE_DEV_LOGIN_FOR_E2E=true   (dev-login backdoor for seeding)
 *
 * All seeded rows are deleted in the finally block regardless of pass/fail.
 */

const SEED_PREFIX = "e2e-ttc-figures-";

/**
 * Normalise a French-locale currency string for comparison.
 *
 * Intl.NumberFormat("fr-FR") renders e.g. "12\u202f000,00\u00a0€" (narrow
 * no-break space as thousands separator, non-breaking space before the
 * currency symbol). Strip every whitespace character so the assertion is
 * independent of the exact space characters used.
 *
 * Returns e.g. "12000,00€" for 12 000, "6000,00€" for 6 000, "0,00€" for 0.
 */
function normalise(text: string): string {
  return text.replace(/\s/g, "");
}

interface Seeded {
  projectId: number;
  contractorId: number;
  devisId: number;
  feeId: number;
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const projectRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, fee_percentage, client_contact_email)
     VALUES ($1, $2, $3, '10.00', $4)
     RETURNING id`,
    [
      `${SEED_PREFIX}project-${uniq}`,
      `${SEED_PREFIX}${uniq}`,
      "TTC Figures Client",
      `${SEED_PREFIX}${uniq}@local.test`,
    ],
  );
  const projectId = projectRes.rows[0].id;

  const contractorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`],
  );
  const contractorId = contractorRes.rows[0].id;

  // Devis: 10 000 HT, 20 % TVA → 12 000 TTC.
  // accounting_state = 'active' so the financial-summary service includes it
  // in Contracted.  No certificats → certifiedTtc = 0.
  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr,
        amount_ht, amount_ttc, invoicing_mode, accounting_state)
     VALUES ($1, $2, $3, $4, '10000.00', '12000.00', 'mode_b', 'active')
     RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D-${uniq}`, "TTC figures test devis"],
  );
  const devisId = devisRes.rows[0].id;

  // Fee for Honoraires page: 5 000 HT, phase = conception.
  // Architect TVA = 20 % → TTC = 6 000.  invoicedAmount = 0 so remaining = 5 000 HT.
  const feeRes = await db.query<{ id: number }>(
    `INSERT INTO fees
       (project_id, fee_type, phase, base_amount_ht, fee_rate, fee_amount_ht,
        invoiced_amount, remaining_amount, status)
     VALUES ($1, 'works_percentage', 'conception', '50000.00', '10.00', '5000.00',
             '0.00', '5000.00', 'active')
     RETURNING id`,
    [projectId],
  );
  const feeId = feeRes.rows[0].id;

  return { projectId, contractorId, devisId, feeId };
}

async function cleanup(db: Client, s: Seeded | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM fees WHERE id = $1", [s.feeId]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[ttc-figures cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("TTC figures — Financial Tracking and Honoraires pages (task #580)", () => {
  test("Financial Tracking: contracted TTC = €12 000, certified TTC = €0, remaining TTC = €12 000", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `${SEED_PREFIX}ft-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let seeded: Seeded | null = null;
    try {
      await devLogin(context.request, email);
      seeded = await seed(db, uniq);

      const page = await context.newPage();
      await page.goto("/suivi-financier");

      // Wait for the project card to appear.
      const card = page.getByTestId(`card-financial-project-${seeded.projectId}`);
      await expect(card).toBeVisible({ timeout: 15_000 });

      // ── Contracted TTC: should display exactly 12 000,00 € TTC ─────────
      // Intl.NumberFormat("fr-FR", EUR) → "12 000,00 €" then the span adds
      // "TTC"; after stripping all whitespace the full normalised string is
      // "12000,00€TTC".
      const contractedTtc = card.getByTestId(`text-contracted-ttc-${seeded.projectId}`);
      await expect(contractedTtc).toBeVisible();
      const contractedTtcText = normalise(await contractedTtc.innerText());
      expect(
        contractedTtcText,
        `contracted TTC expected "12000,00€TTC" (got "${contractedTtcText}")`,
      ).toBe("12000,00€TTC");

      // ── Certified TTC: no certificats → exactly 0,00 € TTC ─────────────
      const certifiedTtc = card.getByTestId(`text-certified-ttc-${seeded.projectId}`);
      await expect(certifiedTtc).toBeVisible();
      const certifiedTtcText = normalise(await certifiedTtc.innerText());
      expect(
        certifiedTtcText,
        `certified TTC expected "0,00€TTC" (got "${certifiedTtcText}")`,
      ).toBe("0,00€TTC");

      // ── Remaining TTC: contracted − certified = exactly 12 000,00 € TTC ─
      const remainingTtc = card.getByTestId(`text-remaining-ttc-${seeded.projectId}`);
      await expect(remainingTtc).toBeVisible();
      const remainingTtcText = normalise(await remainingTtc.innerText());
      expect(
        remainingTtcText,
        `remaining TTC expected "12000,00€TTC" (got "${remainingTtcText}")`,
      ).toBe("12000,00€TTC");
    } finally {
      try {
        await cleanup(db, seeded);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });

  test("Honoraires: summary cards show €6 000 TTC and phase card matches", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `${SEED_PREFIX}hon-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let seeded: Seeded | null = null;
    try {
      await devLogin(context.request, email);
      seeded = await seed(db, uniq);

      const page = await context.newPage();
      await page.goto("/honoraires");

      // Select the seeded project from the project filter dropdown.
      const projectFilter = page.getByTestId("select-fee-project-filter");
      await expect(projectFilter).toBeVisible({ timeout: 10_000 });
      await projectFilter.click();

      const projectCode = `${SEED_PREFIX}${uniq}`;
      await page.getByText(projectCode).click();

      // ── Total Honoraires: 5 000 HT × 1.20 = exactly 6 000,00 € TTC ─────
      const totalEarnedTtc = page.getByTestId("text-total-earned-ttc");
      await expect(totalEarnedTtc).toBeVisible({ timeout: 10_000 });
      const earnedText = normalise(await totalEarnedTtc.innerText());
      expect(
        earnedText,
        `total earned TTC expected "6000,00€TTC" (got "${earnedText}")`,
      ).toBe("6000,00€TTC");

      // ── Total Invoiced: invoiced = 0 → exactly 0,00 € TTC ───────────────
      const totalInvoicedTtc = page.getByTestId("text-total-invoiced-ttc");
      await expect(totalInvoicedTtc).toBeVisible();
      const invoicedText = normalise(await totalInvoicedTtc.innerText());
      expect(
        invoicedText,
        `total invoiced TTC expected "0,00€TTC" (got "${invoicedText}")`,
      ).toBe("0,00€TTC");

      // ── Remaining to Invoice: exactly 6 000,00 € TTC ─────────────────────
      const totalRemainingTtc = page.getByTestId("text-total-remaining-ttc");
      await expect(totalRemainingTtc).toBeVisible();
      const remainingText = normalise(await totalRemainingTtc.innerText());
      expect(
        remainingText,
        `total remaining TTC expected "6000,00€TTC" (got "${remainingText}")`,
      ).toBe("6000,00€TTC");

      // ── Phase summary — Conception: exactly 6 000,00 € TTC ───────────────
      const phaseCard = page.getByTestId("card-phase-summary-conception");
      await expect(phaseCard).toBeVisible({ timeout: 10_000 });

      const phaseTtc = phaseCard.getByTestId("text-phase-total-ttc-conception");
      await expect(phaseTtc).toBeVisible();
      const phaseText = normalise(await phaseTtc.innerText());
      expect(
        phaseText,
        `conception phase TTC expected "6000,00€TTC" (got "${phaseText}")`,
      ).toBe("6000,00€TTC");
    } finally {
      try {
        await cleanup(db, seeded);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
