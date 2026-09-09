import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "pg";

const SEED_PREFIX = "e2e-cert-tva-preview-";
const EVIDENCE_MESSAGE =
  "Aucun traitement de TVA fiable n’a pu être établi. Vérifiez les montants HT/TTC du devis signé ou configurez le taux de TVA du marché ou de l’entreprise.";

interface Seeded {
  projectId: number;
  contractorId: number;
  devis20Id: number;
  devis10Id: number;
}

async function devLogin(api: APIRequestContext, email: string) {
  const response = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    response.ok(),
    `dev-login failed (${response.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const project = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, status)
     VALUES ($1, $2, 'TVA Preview Client', 'active') RETURNING id`,
    [`${SEED_PREFIX}project-${uniq}`, `TVA-${uniq}`],
  );
  const contractor = await db.query<{ id: number }>(
    `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`],
  );
  const projectId = project.rows[0].id;
  const contractorId = contractor.rows[0].id;

  await db.query(
    `INSERT INTO marches
       (project_id, contractor_id, total_ht, total_ttc, retenue_garantie_percent, status)
     VALUES ($1, $2, '30000.00', '36000.00', '0.00', 'active')`,
    [projectId, contractorId],
  );

  const insertDevis = async (code: string, ht: string, ttc: string) => {
    const result = await db.query<{ id: number }>(
      `INSERT INTO devis
         (project_id, contractor_id, devis_code, description_fr,
          amount_ht, amount_ttc, status, sign_off_stage)
       VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', 'client_signed_off')
       RETURNING id`,
      [projectId, contractorId, code, `TVA preview ${code}`, ht, ttc],
    );
    return result.rows[0].id;
  };

  return {
    projectId,
    contractorId,
    devis20Id: await insertDevis(`TVA20-${uniq}`, "10000.00", "12000.00"),
    devis10Id: await insertDevis(`TVA10-${uniq}`, "5000.00", "5500.00"),
  };
}

async function cleanup(db: Client, seeded: Seeded | null) {
  if (!seeded) return;
  await db.query("DELETE FROM projects WHERE id = $1", [seeded.projectId]);
  await db.query("DELETE FROM contractors WHERE id = $1", [seeded.contractorId]);
}

function preview(body: Record<string, unknown>, rate: number) {
  const entered = Number(body.totalWorksAmount);
  const basis = body.totalWorksAmountBasis === "ttc" ? "ttc" : "ht";
  const amountHt = basis === "ht" ? entered : entered / (1 + rate / 100);
  const amountTtc = basis === "ttc" ? entered : entered * (1 + rate / 100);
  const tva = amountTtc - amountHt;

  return {
    works: {
      enteredAmount: entered.toFixed(2),
      enteredBasis: basis,
      amountHt: amountHt.toFixed(2),
      amountTtc: amountTtc.toFixed(2),
    },
    deductions: {
      retenueGarantie: "0.00",
      cumulativeProrataDeduction: "0.00",
      periodProrataDeduction: "0.00",
      cumulativeAcompteRecoupment: "0.00",
      periodAcompteRecoupment: "0.00",
      retenueReleaseAmount: "0.00",
      netToPayHt: amountHt.toFixed(2),
      tvaAmount: tva.toFixed(2),
      netToPayTtc: amountTtc.toFixed(2),
      tvaRatePercent: rate.toFixed(2),
      tvaAutoliquidation: false,
      tvaRateSource: "signed_quotation",
    },
    tva: {
      ratePercent: rate.toFixed(2),
      autoliquidation: false,
      source: "signed_quotation",
      evidenceKind: "signed_quotation",
    },
  };
}

async function installPreviewRouter(page: Page, seeded: Seeded) {
  await page.route("**/api/projects/*/certificats/manual-preview", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const amount = String(body.totalWorksAmount);

    if (amount === "777") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "TVA_EVIDENCE_REQUIRED",
          message: EVIDENCE_MESSAGE,
        }),
      });
      return;
    }

    const contextDevisId = Number(body.contextDevisId);
    const rate =
      amount === "111" ? 11 : amount === "222" ? 22 : contextDevisId === seeded.devis10Id ? 10 : 20;
    const delay = amount === "111" || contextDevisId === seeded.devis20Id ? 350 : 25;
    await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(preview(body, rate)),
    });
  });
}

async function selectOption(page: Page, triggerTestId: string, optionText: RegExp) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole("option", { name: optionText }).click();
}

test.describe("Manual certificat TVA preview ordering", () => {
  test("HT/TTC parity, stale input/context rejection, and evidence blocking work in both entry points", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let seeded: Seeded | null = null;

    try {
      await devLogin(context.request, `${SEED_PREFIX}${uniq}@local.test`);
      seeded = await seed(db, uniq);
      const page = await context.newPage();
      await installPreviewRouter(page, seeded);

      // Project detail entry point: switching HT → TTC yields the same
      // authoritative pair, and a slower old amount cannot replace the latest.
      await page.goto(`/projets/${seeded.projectId}`);
      await page.getByTestId("tab-certificats").click();
      const contextButton = page.getByTestId(`button-certificat-context-${seeded.devis20Id}`);
      await expect(contextButton).toBeVisible({ timeout: 15_000 });
      await contextButton.click();

      const tabHt = page.getByTestId("input-cert-works-tab-ht");
      const tabTtc = page.getByTestId("input-cert-works-tab-ttc");
      const tabRate = page.getByTestId("input-cert-works-tab-rate");
      const tabSubmit = page.getByTestId("button-submit-cert-tab");

      await tabHt.fill("100");
      await expect(tabTtc).toHaveValue("120.00");
      await expect(tabRate).toHaveText(/20\s*%/);
      await tabTtc.fill("120");
      await expect(tabHt).toHaveValue("100.00");
      await expect(tabRate).toHaveText(/20\s*%/);

      await tabHt.fill("111");
      await tabHt.fill("222");
      await expect(tabRate).toHaveText(/22\s*%/);
      await page.waitForTimeout(450);
      await expect(tabRate).toHaveText(/22\s*%/);

      await tabHt.fill("777");
      await expect(page.getByTestId("input-cert-works-tab-decision")).toContainText(
        "Vérifiez les montants HT/TTC du devis signé",
      );
      await expect(tabSubmit).toBeDisabled();

      // Global entry point: changing quotation while the first preview is still
      // pending must leave the second quotation's decision on screen.
      await page.goto(`/certificats?projectId=${seeded.projectId}`);
      await page.getByTestId("button-new-certificat").click();
      await selectOption(page, "select-cert-contractor", new RegExp(`${SEED_PREFIX}contractor-${uniq}`));

      await selectOption(page, "select-cert-devis", new RegExp(`TVA20-${uniq}`));
      await selectOption(page, "select-cert-devis", new RegExp(`TVA10-${uniq}`));

      const globalRate = page.getByTestId("input-cert-total-works-rate");
      await expect(globalRate).toHaveText(/10\s*%/);
      await page.waitForTimeout(450);
      await expect(globalRate).toHaveText(/10\s*%/);

      const globalHt = page.getByTestId("input-cert-total-works-ht");
      const globalTtc = page.getByTestId("input-cert-total-works-ttc");
      await globalHt.fill("100");
      await expect(globalTtc).toHaveValue("110.00");
      await globalTtc.fill("110");
      await expect(globalHt).toHaveValue("100.00");

      await globalHt.fill("777");
      await expect(page.getByTestId("input-cert-total-works-decision")).toContainText(
        "Vérifiez les montants HT/TTC du devis signé",
      );
      await expect(page.getByTestId("button-submit-certificat")).toBeDisabled();
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