import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the Needs Review anomaly-resolution UI (Task #233).
 *
 * Task #236 added API-level coverage of the resolution lifecycle; this test
 * exercises the actual browser surface so a regression where a confirm/dismiss
 * succeeds on the backend but the card/badge fails to update on screen is
 * caught. It seeds a project with a single `needs_review` overlap case (one
 * consolidated "primary" devis appearing to absorb two earlier active member
 * devis), loads `/projets/:id?tab=review`, and asserts:
 *   - the open decision card renders with its euros-of-double-counting impact
 *     figure and the accounting-status badge reads "Needs review";
 *   - clicking Confirm removes the card from the open queue, flips the badge to
 *     "Resolved", and surfaces the case under the History (resolved) view with
 *     a "Superseded" decision marker;
 *   - the same for Dismiss (Keep separate → "Kept separate").
 *
 * REQUIRES the server to be booted with:
 *   - ENABLE_DEV_LOGIN_FOR_E2E=true   (dev-login backdoor for the session the
 *                                      authenticated POST /resolve route needs)
 *
 * All seeded rows are removed in the finally block regardless of pass/fail.
 */

const SEED_PREFIX = "e2e-needs-review-";

interface Seeded {
  projectId: number;
  contractorId: number;
  primaryDevisId: number;
  memberDevisIds: number[];
  caseId: number;
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
      "Needs Review Client",
      `${SEED_PREFIX}${uniq}@local.test`,
    ],
  );
  const projectId = projectRes.rows[0].id;

  const contractorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`],
  );
  const contractorId = contractorRes.rows[0].id;

  // The consolidated "primary" devis is provisional (under review); the two
  // member devis are `active` so they currently count toward Contracted, which
  // makes the case's impact = 5000 + 3000 = 8000 €.
  const insertDevis = async (
    code: string,
    amountHt: string,
    amountTtc: string,
    accountingState: "provisional" | "active" | "superseded",
  ): Promise<number> => {
    const r = await db.query<{ id: number }>(
      `INSERT INTO devis
         (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc, accounting_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [projectId, contractorId, code, `${code} description`, amountHt, amountTtc, accountingState],
    );
    return r.rows[0].id;
  };

  const primaryDevisId = await insertDevis(`${SEED_PREFIX}PRIM-${uniq}`, "8000.00", "9600.00", "provisional");
  const member1 = await insertDevis(`${SEED_PREFIX}M1-${uniq}`, "5000.00", "6000.00", "active");
  const member2 = await insertDevis(`${SEED_PREFIX}M2-${uniq}`, "3000.00", "3600.00", "active");
  const memberDevisIds = [member1, member2];

  const caseRes = await db.query<{ id: number }>(
    `INSERT INTO overlap_cases
       (project_id, case_key, relationship_type, primary_devis_id, member_devis_ids,
        detection_source, confidence, verdict, citations, reasoning, status)
     VALUES ($1, $2, 'aggregates', $3, $4::jsonb, 'semantic', '0.650', 'needs_review',
             '[]'::jsonb, $5, 'active')
     RETURNING id`,
    [
      projectId,
      `${SEED_PREFIX}key-${uniq}`,
      primaryDevisId,
      JSON.stringify(memberDevisIds),
      "Possible consolidation of two earlier devis into one.",
    ],
  );
  const caseId = caseRes.rows[0].id;

  return { projectId, contractorId, primaryDevisId, memberDevisIds, caseId };
}

async function cleanup(db: Client, s: Seeded | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM accounting_state_changes WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM overlap_cases WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM devis WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[needs-review cleanup] swallowed:", (err as Error).message);
    }
  }
}

/**
 * Drive a single confirm/dismiss decision through the UI and assert the queue
 * visibly clears and the case re-appears under the resolved history view.
 */
async function runDecision(
  page: Page,
  s: Seeded,
  opts: {
    buttonTestId: string;
    toast: RegExp;
    resolvedLabel: RegExp;
  },
) {
  await page.goto(`/projets/${s.projectId}?tab=review`);

  // The decision card for the seeded open case must render.
  const card = page.getByTestId(`card-review-${s.caseId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });

  // The euros-of-double-counting impact line (members 5000 + 3000 = 8000 €).
  const impact = page.getByTestId(`impact-euros-${s.caseId}`);
  await expect(impact).toBeVisible();
  await expect(impact).toContainText("000");

  // Scope the status badge to the review tab panel — the project header also
  // renders one (only while needs_review), so an unscoped locator is ambiguous.
  const reviewPanelBadge = page
    .locator('[role="tabpanel"]')
    .getByTestId("badge-accounting-status");
  await expect(reviewPanelBadge).toHaveText(/Needs review/i);

  // Make the decision.
  await page.getByTestId(opts.buttonTestId).click();
  await expect(page.getByText(opts.toast).first()).toBeVisible({ timeout: 5_000 });

  // The card must leave the open queue (query invalidation re-renders the list).
  await expect(card).toHaveCount(0, { timeout: 10_000 });

  // The status badge flips to Resolved (needsReviewCount → 0).
  await expect(reviewPanelBadge).toHaveText(/Resolved/i, { timeout: 10_000 });

  // The decision is now visible under the resolved History accordion.
  await page.getByTestId("button-toggle-resolved").click();
  await expect(page.getByTestId("list-resolved-cases")).toBeVisible();
  const resolvedRow = page.getByTestId(`row-resolved-${s.caseId}`);
  await expect(resolvedRow).toBeVisible();
  await expect(page.getByTestId(`text-resolved-decision-${s.caseId}`)).toHaveText(opts.resolvedLabel);
}

test.describe("Needs Review — confirm/dismiss visibly clears the queue (task #233)", () => {
  test("Confirm supersedes the earlier devis and moves the case to history", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `${SEED_PREFIX}confirm-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let seeded: Seeded | null = null;
    try {
      await devLogin(context.request, email);
      seeded = await seed(db, uniq);

      const page = await context.newPage();
      await runDecision(page, seeded, {
        buttonTestId: `button-confirm-supersede-${seeded.caseId}`,
        toast: /Overlap confirmed/i,
        resolvedLabel: /Superseded/i,
      });
    } finally {
      try {
        await cleanup(db, seeded);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });

  test("Dismiss keeps the devis separate and moves the case to history", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `${SEED_PREFIX}dismiss-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let seeded: Seeded | null = null;
    try {
      await devLogin(context.request, email);
      seeded = await seed(db, uniq);

      const page = await context.newPage();
      await runDecision(page, seeded, {
        buttonTestId: `button-keep-separate-${seeded.caseId}`,
        toast: /Kept separate/i,
        resolvedLabel: /Kept separate/i,
      });
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
