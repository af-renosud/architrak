import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the per-row "Drive" chip on the /certificats page
 * (task #199).
 *
 * Verifies:
 *   1. When a certificat has a populated `driveWebViewLink`, the row chip
 *      `link-view-on-drive-cert-<id>` is visible, points to the correct URL,
 *      and opens in a new tab (`target="_blank"`).
 *   2. When `driveWebViewLink` is null, no row chip is rendered.
 *
 * The Drive auto-upload feature is OFF by default in dev, and the public
 * API doesn't expose `driveWebViewLink` on create — we set it directly via
 * SQL after seeding so the test never touches Google Drive.
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true so that
 * POST /api/auth/dev-login is registered, plus DATABASE_URL.
 */

interface SeededCert {
  id: number;
  certificateRef: string;
}

interface Seed {
  projectId: number;
  contractorId: number;
  withLink: SeededCert;
  withoutLink: SeededCert;
}

const DRIVE_URL = "https://drive.google.com/file/d/FAKE_CERT_FILE_ID/view?usp=drivesdk";

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

async function createCertificat(
  api: APIRequestContext,
  projectId: number,
  contractorId: number,
): Promise<SeededCert> {
  return postOk<SeededCert>(api, `/api/projects/${projectId}/certificats`, {
    contractorId,
    totalWorksHt: "1000.00",
    pvMvAdjustment: "0.00",
    previousPayments: "0.00",
    retenueGarantie: "0.00",
    netToPayHt: "1000.00",
    tvaAmount: "200.00",
    netToPayTtc: "1200.00",
    status: "draft",
  });
}

async function seed(api: APIRequestContext, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `CertDrive ${uniq}`,
    code: `CD-${uniq}`,
    clientName: "Cert Drive Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `CertDrive Co ${uniq}`,
  });
  const withLink = await createCertificat(api, project.id, contractor.id);
  const withoutLink = await createCertificat(api, project.id, contractor.id);
  return { projectId: project.id, contractorId: contractor.id, withLink, withoutLink };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const ids = [s.withLink.id, s.withoutLink.id];
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM certificats WHERE id = ANY($1::int[])", [ids]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[cert-drive-link cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Certificats — per-row Drive chip (task #199)", () => {
  test("row chip renders only when driveWebViewLink is populated", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-cert-drive-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(context.request, uniq);

      // Populate driveWebViewLink on ONE of the two certs (no public API).
      await db.query(
        "UPDATE certificats SET drive_file_id = $1, drive_web_view_link = $2, drive_uploaded_at = NOW() WHERE id = $3",
        ["FAKE_CERT_FILE_ID", DRIVE_URL, s.withLink.id],
      );

      const page = await context.newPage();
      await page.goto("/certificats");

      // Filter by the seeded project so unrelated rows don't pollute the view.
      await page.getByTestId("select-project-filter").click();
      await page.getByRole("option", { name: new RegExp(`CD-${uniq}`) }).click();

      // Both rows render.
      await expect(page.getByTestId(`card-certificat-${s.withLink.id}`)).toBeVisible();
      await expect(page.getByTestId(`card-certificat-${s.withoutLink.id}`)).toBeVisible();

      // ---- 1. Cert WITH link: chip is visible, has correct href + target ----
      const chip = page.getByTestId(`link-view-on-drive-cert-${s.withLink.id}`);
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute("href", DRIVE_URL);
      await expect(chip).toHaveAttribute("target", "_blank");

      // ---- 2. Cert WITHOUT link: chip is NOT rendered ----
      await expect(
        page.getByTestId(`link-view-on-drive-cert-${s.withoutLink.id}`),
      ).toHaveCount(0);
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
