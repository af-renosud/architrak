import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E coverage for the AI-timeout retry prompt on cost-analysis generation
 * (Task #385, verifying Task #384).
 *
 * Uses Playwright route interception to force the FIRST generate call to
 * return 504 { code: "ai_timeout" } and lets the second one hit the real
 * (fake-Gemini) endpoint:
 *   1. The friendly "The AI took too long" toast shows with the Retry action.
 *   2. Clicking Retry re-issues the generate request and succeeds — the
 *      draft badge appears and the server row exists.
 *   3. A non-timeout error (502, no code) surfaces its message verbatim
 *      with NO retry button.
 *
 * Hermetic: boots ITS OWN app instance with ENABLE_DEV_LOGIN_FOR_E2E=true
 * and E2E_FAKE_GEMINI=true.
 */

const APP_PORT = 5187;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

async function startAppServer(): Promise<{
  proc: ChildProcessWithoutNullStreams;
  stop: () => Promise<void>;
}> {
  const output: string[] = [];
  const proc = spawn("npx", ["tsx", "server/index.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(APP_PORT),
      PUBLIC_BASE_URL: APP_URL,
      E2E_FAKE_GMAIL: "true",
      E2E_FAKE_GEMINI: "true",
      ENABLE_DEV_LOGIN_FOR_E2E: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d: Buffer) => output.push(d.toString()));
  proc.stderr.on("data", (d: Buffer) => output.push(d.toString()));

  const deadline = Date.now() + 120_000;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `app server exited early (code ${proc.exitCode}). Output tail:\n${output.join("").slice(-3000)}`,
      );
    }
    try {
      const res = await fetch(`${APP_URL}/healthz`);
      if (res.ok) break;
      lastErr = `healthz ${res.status}`;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const healthy = await fetch(`${APP_URL}/healthz`).then((r) => r.ok).catch(() => false);
  if (!healthy) {
    throw new Error(`app server never became healthy (${lastErr}). Output tail:\n${output.join("").slice(-3000)}`);
  }
  return {
    proc,
    stop: () =>
      new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        }, 5000);
      }),
  };
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

async function postOk<T = unknown>(api: APIRequestContext, url: string, body: unknown): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `${url} failed: ${res.status()} ${await safeText(res)}`).toBe(true);
  return (await res.json()) as T;
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`).toBe(true);
}

interface Seed {
  projectId: number;
  contractorId: number;
  devisId: number;
}

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `AiTimeout ${uniq}`,
    code: `AT-${uniq}`,
    clientName: "AT Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `AiTimeout Co ${uniq}`,
  });
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `AT-D-${uniq}`,
    descriptionFr: `AI timeout devis ${uniq}`,
    amountHt: "100.00",
    amountTtc: "120.00",
    invoicingMode: "mode_a",
  });
  await postOk<{ id: number }>(api, `/api/devis/${devis.id}/line-items`, {
    lineNumber: 1,
    description: "Peinture des murs du salon",
    quantity: "1",
    unit: "u",
    unitPriceHt: "100.00",
    totalHt: "100.00",
  });
  // Editable (draft) translation row so the Translation tab renders the
  // cost-analysis card in its normal editable state.
  await db.query(
    `INSERT INTO devis_translations (devis_id, status, line_translations, header_translated, updated_at)
     VALUES ($1, 'draft', $2::jsonb, '{}'::jsonb, NOW())
     ON CONFLICT (devis_id) DO UPDATE SET status = 'draft', line_translations = $2::jsonb`,
    [
      devis.id,
      JSON.stringify([
        { lineNumber: 1, originalDescription: "Peinture des murs du salon", translation: "Painting of the living-room walls" },
      ]),
    ],
  );
  return { projectId: project.id, contractorId: contractor.id, devisId: devis.id };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM devis_cost_analyses WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis_translations WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis_line_items WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[ai-timeout cleanup] swallowed:", (err as Error).message);
    }
  }
}

/** Navigate to the devis translation tab and open the cost-analysis card. */
async function openCostAnalysisCard(page: Page, s: Seed) {
  await page.goto(`${APP_URL}/projets/${s.projectId}`);
  await page.getByTestId("tab-devis").click();
  await page.getByTestId(`row-devis-toggle-${s.devisId}`).click();
  await page.getByTestId(`tab-translation-${s.devisId}`).click();
  const toggle = page.getByTestId("button-toggle-cost-analysis");
  await expect(toggle).toBeVisible();
  await toggle.click();
}

test.describe("Cost analysis AI-timeout retry prompt (task #385)", () => {
  let app: Awaited<ReturnType<typeof startAppServer>> | null = null;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    app = await startAppServer();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("timeout → friendly toast → Retry re-issues and succeeds", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({
      baseURL: APP_URL,
      viewport: { width: 1600, height: 1000 },
    });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, `e2e-aitimeout-${uniq}@local.test`);
      s = await seed(context.request, db, uniq);

      const page = await context.newPage();

      // Intercept ONLY the first generate call → 504 ai_timeout; the retry
      // passes through to the real (fake-Gemini) endpoint.
      let generateCalls = 0;
      await page.route(`**/api/devis/${s.devisId}/cost-analysis/generate`, async (route) => {
        generateCalls += 1;
        if (generateCalls === 1) {
          await route.fulfill({
            status: 504,
            contentType: "application/json",
            body: JSON.stringify({
              message: "The AI took too long to respond. This is usually temporary — try again.",
              code: "ai_timeout",
            }),
          });
          return;
        }
        await route.continue();
      });

      await openCostAnalysisCard(page, s);
      await page.getByTestId("button-generate-cost-analysis").click();

      // Friendly toast with Retry action — NOT the raw error.
      await expect(page.getByText("The AI took too long", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/retrying often succeeds/).first()).toBeVisible();
      const retryButton = page.getByTestId("button-retry-cost-analysis");
      await expect(retryButton).toBeVisible();

      // Retry → second request passes through and succeeds.
      await retryButton.click();
      await expect(page.getByTestId("badge-cost-analysis-status")).toHaveText(/Draft — not in PDF/, {
        timeout: 20_000,
      });
      expect(generateCalls).toBe(2);

      // Server row really exists.
      const res = await context.request.get(`/api/devis/${s.devisId}/cost-analysis`);
      expect(res.ok()).toBe(true);
      const row = (await res.json()) as { analysis: { status: string } | null };
      expect(row.analysis?.status).toBe("draft");
    } finally {
      await cleanup(db, s);
      await db.end().catch(() => {});
      await context.close();
    }
  });

  test("non-timeout errors surface verbatim without a retry button", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}x`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({
      baseURL: APP_URL,
      viewport: { width: 1600, height: 1000 },
    });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, `e2e-aierr-${uniq}@local.test`);
      s = await seed(context.request, db, uniq);

      const page = await context.newPage();

      const verbatimMessage = "Cost analysis generation failed: Gemini blocked the request: SAFETY";
      await page.route(`**/api/devis/${s.devisId}/cost-analysis/generate`, async (route) => {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ message: verbatimMessage }),
        });
      });

      await openCostAnalysisCard(page, s);
      await page.getByTestId("button-generate-cost-analysis").click();

      // Generic destructive toast with the verbatim message; no retry action.
      await expect(page.getByText("Cost analysis", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(verbatimMessage, { exact: true }).first()).toBeVisible();
      await expect(page.getByTestId("button-retry-cost-analysis")).toHaveCount(0);
      await expect(page.getByText("The AI took too long", { exact: true })).toHaveCount(0);
    } finally {
      await cleanup(db, s);
      await db.end().catch(() => {});
      await context.close();
    }
  });
});
