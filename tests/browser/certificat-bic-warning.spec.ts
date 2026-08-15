import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the BIC-missing amber warning on the /certificats page
 * (task #489 — verifying task #487 wiring).
 *
 * Verifies:
 *   1. When a draft certificat belongs to a contractor without a SWIFT/BIC,
 *      the per-card warning `warning-bic-missing-card-<id>` is visible.
 *   2. When the same contractor is selected in the "New Certificat" create
 *      dialog, the inline form warning `warning-bic-missing-form` is visible.
 *
 * The contractor is created without a BIC (the field defaults to null), so
 * no direct DB manipulation is required for the main assertions.
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true plus
 * DATABASE_URL for seeding cleanup.
 */

interface SeededCert {
  id: number;
  certificateRef: string;
}

interface Seed {
  projectId: number;
  contractorId: number;
  cert: SeededCert;
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
    name: `BicWarn ${uniq}`,
    code: `BW-${uniq}`,
    clientName: "BIC Warn Client",
  });
  // Deliberately no `bic` field — contractor is created with bic = null
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `NoBic Co ${uniq}`,
  });
  const cert = await postOk<SeededCert>(
    api,
    `/api/projects/${project.id}/certificats`,
    {
      contractorId: contractor.id,
      totalWorksHt: "5000.00",
      pvMvAdjustment: "0.00",
      previousPayments: "0.00",
      retenueGarantie: "0.00",
      netToPayHt: "5000.00",
      tvaAmount: "1000.00",
      netToPayTtc: "6000.00",
      status: "draft",
    },
  );
  return { projectId: project.id, contractorId: contractor.id, cert };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM certificats WHERE id = $1", [s.cert.id]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[cert-bic-warning cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Certificats — BIC-missing amber warning (task #489)", () => {
  test(
    "card warning shows for draft cert; form warning shows when contractor selected",
    async ({ browser }) => {
      const databaseUrl = process.env.DATABASE_URL;
      expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

      const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const email = `e2e-cert-bic-${uniq}@local.test`;
      const db = new Client({ connectionString: databaseUrl! });
      await db.connect();

      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      let s: Seed | null = null;

      try {
        await devLogin(context.request, email);
        s = await seed(context.request, uniq);

        const page = await context.newPage();
        await page.goto("/certificats");

        // ── Select the seeded project to narrow the card list ──────────────
        await page.getByTestId("select-project-filter").click();
        await page.getByRole("option", { name: new RegExp(`BW-${uniq}`) }).click();

        // ── 1. Card-level warning is visible on the draft cert ──────────────
        await expect(
          page.getByTestId(`card-certificat-${s.cert.id}`),
        ).toBeVisible();

        await expect(
          page.getByTestId(`warning-bic-missing-card-${s.cert.id}`),
        ).toBeVisible();

        // ── 2. Open the create dialog and pick the no-BIC contractor ───────
        await page.getByTestId("button-new-certificat").click();

        // The contractor select inside the dialog
        await page.getByTestId("select-cert-contractor").click();
        await page
          .getByRole("option", { name: new RegExp(`NoBic Co ${uniq}`) })
          .click();

        // The form-level warning should appear immediately
        await expect(
          page.getByTestId("warning-bic-missing-form"),
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
