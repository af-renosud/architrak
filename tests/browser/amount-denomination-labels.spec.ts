import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * Task #579 — Confirm that euro amounts are always accompanied by a
 * denomination label (HT / TTC / …) in the two places that matter most:
 *
 *   1. The Certificat detail dialog (opened from the project's Certificats tab)
 *   2. The project-detail financial summary cards (Résumé tab)
 *
 * A regression here (denomination span disappearing after the <Amount>
 * migration) is visually silent — the number still renders but the HT/TTC
 * distinction is lost for the user.
 *
 * Also verifies that `denomination="none"` does NOT inject a stray label by
 * checking that the net-TTC *amount* span doesn't contain a redundant "TTC"
 * suffix (the label lives in the adjacent heading row, not duplicated inside
 * the value cell).
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true so that
 * POST /api/auth/dev-login is registered, plus DATABASE_URL.
 */

interface Seed {
  projectId: number;
  contractorId: number;
  certId: number;
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
  expect(
    res.ok(),
    `${url} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`,
  ).toBe(true);
  return (await res.json()) as T;
}

async function seed(api: APIRequestContext, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `AmtLabel ${uniq}`,
    code: `AL-${uniq}`,
    clientName: "Amount Label Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `AmtLabel Co ${uniq}`,
  });
  // Certificat with non-zero HT, TVA and TTC amounts so both labels are
  // meaningful and not hidden by a "0,00 €" rendering.
  const cert = await postOk<{ id: number }>(
    api,
    `/api/projects/${project.id}/certificats`,
    {
      contractorId: contractor.id,
      totalWorksHt: "5000.00",
      pvMvAdjustment: "0.00",
      previousPayments: "0.00",
      retenueGarantie: "250.00",
      netToPayHt: "4750.00",
      tvaAmount: "950.00",
      netToPayTtc: "5700.00",
      status: "draft",
    },
  );
  return {
    projectId: project.id,
    contractorId: contractor.id,
    certId: cert.id,
  };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM certificats WHERE id = $1", [s.certId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[amount-denomination cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Amount denomination labels — /certificats list page (task #583)", () => {
  test("certificats list page shows TTC label next to a numeric figure on each card", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-amt-list-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(context.request, uniq);

      const page = await context.newPage();
      // Navigate to the top-level certificats list page.
      await page.goto("/certificats");

      // Wait for the page title to confirm the page has loaded.
      await expect(page.getByTestId("text-page-title")).toBeVisible();

      // Select the seeded project from the project filter dropdown.
      // The SelectTrigger opens the dropdown; then click the matching item.
      await page.getByTestId("select-project-filter").click();
      await page.getByRole("option", { name: new RegExp(`AL-${uniq}`) }).click();

      // Wait for the seeded certificat card to appear.
      const certCard = page.getByTestId(`card-certificat-${s.certId}`);
      await expect(certCard).toBeVisible();

      // ── 1. The amount cell is visible and euro-formatted ───────────────
      const amountEl = page.getByTestId(`text-cert-amount-${s.certId}`);
      await expect(amountEl).toBeVisible();
      await expect(amountEl).toContainText("€");

      // ── 2. A "TTC" denomination label sits next to the numeric figure ──
      // The card renders a <p>TTC</p> sibling directly below the amount span.
      await expect(certCard.getByText("TTC").first()).toBeVisible();
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

test.describe("Amount denomination labels (task #579)", () => {
  test("certificat detail dialog shows HT and TTC labels next to numeric figures", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-amt-cert-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(context.request, uniq);

      const page = await context.newPage();
      // Navigate to the project page — route is /projets/:id (French).
      await page.goto(`/projets/${s.projectId}`);

      // Wait for the project to load (project name header is reliable).
      await expect(page.getByTestId("text-project-name")).toBeVisible();

      // Click the Certificats tab.
      await page.getByTestId("tab-certificats").click();

      // Wait for the seeded certificat card to appear.
      await expect(
        page.getByTestId(`card-certificat-tab-${s.certId}`),
      ).toBeVisible();

      // Open the detail dialog.
      await page.getByTestId(`button-view-cert-tab-${s.certId}`).click();

      // ── 1. "Net to Pay TTC" row label is visible ─────────────────────
      await expect(page.getByText(/Net to Pay TTC/i)).toBeVisible();

      // ── 2. The TTC amount cell is rendered and contains a euro figure ─
      const netTtcEl = page.getByTestId("text-cert-detail-net-ttc");
      await expect(netTtcEl).toBeVisible();
      await expect(netTtcEl).toContainText("€");

      // ── 3. An HT label is visible in at least one detail row ─────────
      // "Total Works HT", "Net to Pay HT", etc. confirm HT denomination.
      // Scope to the dialog overlay to avoid false positives from the tab.
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog.getByText(/\bHT\b/).first()).toBeVisible();

      // ── 4. The HT net-to-pay amount cell is rendered ─────────────────
      const netHtEl = page.getByTestId("text-cert-detail-net-ht");
      await expect(netHtEl).toBeVisible();
      await expect(netHtEl).toContainText("€");

      // ── 5. denomination="none" guard: the net-TTC *amount* span must
      //    NOT end with "TTC" — the label lives in the adjacent heading,
      //    not duplicated inside the value cell itself.
      //    (After the Amount migration, denomination="none" is expected
      //    here so that the hardcoded heading row does the labelling.)
      const netTtcText = await netTtcEl.textContent();
      expect(
        netTtcText?.trim().endsWith("TTC"),
        `text-cert-detail-net-ttc should not contain a "TTC" suffix (got: "${netTtcText?.trim()}")`,
      ).toBe(false);
    } finally {
      try {
        await cleanup(db, s);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });

  test("project-detail financial summary cards show TTC and HT labels", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-amt-summary-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(context.request, uniq);

      const page = await context.newPage();
      // Land on the default "résumé" tab — route is /projets/:id.
      await page.goto(`/projets/${s.projectId}`);

      // Wait for the project header to confirm the page has loaded.
      await expect(page.getByTestId("text-project-name")).toBeVisible();

      // Click the résumé tab explicitly (it may already be active, that's fine).
      await page.getByTestId("tab-resume").click();

      // ── 1. "Total Contracted" card shows TTC label ──────────────────
      const contractedCard = page.getByTestId("card-total-contracted");
      await expect(contractedCard).toBeVisible();
      // The card renders the TTC figure followed by a "TTC" span/text node.
      await expect(contractedCard.getByText("TTC").first()).toBeVisible();

      // ── 2. "Total Contracted" card also shows an HT line ────────────
      await expect(contractedCard.getByText("HT").first()).toBeVisible();

      // ── 3. "Total Certified" card shows TTC label ───────────────────
      const certifiedCard = page.getByTestId("card-total-certified");
      await expect(certifiedCard).toBeVisible();
      await expect(certifiedCard.getByText("TTC").first()).toBeVisible();

      // ── 4. "Total Certified" card also shows HT ─────────────────────
      await expect(certifiedCard.getByText("HT").first()).toBeVisible();

      // ── 5. "Reste à Réaliser" card shows TTC and HT labels ──────────
      const resteCard = page.getByTestId("card-total-reste");
      await expect(resteCard).toBeVisible();
      await expect(resteCard.getByText("TTC").first()).toBeVisible();
      await expect(resteCard.getByText("HT").first()).toBeVisible();

      // ── 6. Primary amount values are euro-formatted numbers ──────────
      const contractedFigure = page.getByTestId("text-total-contracted");
      await expect(contractedFigure).toBeVisible();
      await expect(contractedFigure).toContainText("€");

      const certifiedFigure = page.getByTestId("text-total-certified");
      await expect(certifiedFigure).toBeVisible();
      await expect(certifiedFigure).toContainText("€");
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
