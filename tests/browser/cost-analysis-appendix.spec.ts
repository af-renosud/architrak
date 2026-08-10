import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E coverage for the in-app AI cost-analysis appendix (Task #378).
 *
 * Covers the full draft → confirm workflow with a MOCKED AI:
 *   1. "Generate cost analysis" (E2E_FAKE_GEMINI returns a canned response
 *      that includes a fragmented table row) produces a draft with the
 *      reassembly warning surfaced and a rendered preview table.
 *   2. Confirm attaches the analysis ("Attached to PDF" badge) and the
 *      server row flips to status=confirmed.
 *   3. Editing the raw text demotes it to a draft again on save.
 *   4. Remove deletes the analysis after the confirm dialog.
 *
 * Hermetic: boots ITS OWN app instance with ENABLE_DEV_LOGIN_FOR_E2E=true
 * and E2E_FAKE_GEMINI=true.
 */

const APP_PORT = 5183;
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
    name: `CostAn ${uniq}`,
    code: `CA-${uniq}`,
    clientName: "CA Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `CostAn Co ${uniq}`,
  });
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `CA-D-${uniq}`,
    descriptionFr: `Cost analysis devis ${uniq}`,
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
  // Seed an editable (draft) translation row so the Translation tab renders
  // its normal editable state around the cost-analysis card.
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
      console.warn("[cost-analysis cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Cost analysis appendix (task #378)", () => {
  let app: Awaited<ReturnType<typeof startAppServer>> | null = null;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    app = await startAppServer();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("generate → review warnings → confirm → edit demotes → remove", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-costan-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({
      baseURL: APP_URL,
      viewport: { width: 1600, height: 1000 },
    });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(context.request, db, uniq);

      const page = await context.newPage();
      await page.goto(`${APP_URL}/projets/${s.projectId}`);
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${s.devisId}`).click();
      await page.getByTestId(`tab-translation-${s.devisId}`).click();

      // -------- Card starts collapsed, no analysis --------
      const toggle = page.getByTestId("button-toggle-cost-analysis");
      await expect(toggle).toBeVisible();
      await expect(page.getByTestId("badge-cost-analysis-status")).toHaveCount(0);
      await toggle.click();

      // -------- Generate (fake Gemini) --------
      await page.getByTestId("button-generate-cost-analysis").click();
      await expect(page.getByTestId("badge-cost-analysis-status")).toHaveText(/Draft — not in PDF/, { timeout: 15_000 });
      // Fake output contains a fragmented table row → reassembly warning.
      await expect(page.getByTestId("cost-analysis-warnings")).toContainText("reassembled");
      // Preview renders the parsed table with the reassembled row.
      const preview = page.getByTestId("cost-analysis-preview");
      await expect(preview).toContainText("Cost Center Summary");
      await expect(preview).toContainText("€20,997.87");
      await expect(preview).toContainText("Structural Works");

      // -------- Confirm & attach --------
      await page.getByTestId("button-confirm-cost-analysis").click();
      await expect(page.getByTestId("badge-cost-analysis-status")).toHaveText(/Attached to PDF/, { timeout: 10_000 });

      let res = await context.request.get(`/api/devis/${s.devisId}/cost-analysis`);
      expect(res.ok()).toBe(true);
      let row = (await res.json()) as { analysis: { status: string; revision: number } };
      expect(row.analysis.status).toBe("confirmed");

      // -------- Editing demotes to draft --------
      await page.getByTestId("textarea-cost-analysis").fill("## Summary\nEdited by the architect.");
      await page.getByTestId("button-save-cost-analysis").click();
      await expect(page.getByTestId("badge-cost-analysis-status")).toHaveText(/Draft — not in PDF/, { timeout: 10_000 });
      await expect(page.getByTestId("cost-analysis-preview")).toContainText("Edited by the architect.");

      res = await context.request.get(`/api/devis/${s.devisId}/cost-analysis`);
      row = (await res.json()) as { analysis: { status: string; revision: number } };
      expect(row.analysis.status).toBe("draft");

      // -------- Remove --------
      await page.getByTestId("button-remove-cost-analysis").click();
      await page.getByTestId("button-confirm-remove-analysis").click();
      await expect(page.getByTestId("badge-cost-analysis-status")).toHaveCount(0, { timeout: 10_000 });

      res = await context.request.get(`/api/devis/${s.devisId}/cost-analysis`);
      const finalRow = (await res.json()) as { analysis: null };
      expect(finalRow.analysis).toBeNull();
    } finally {
      await cleanup(db, s);
      await db.end().catch(() => {});
      await context.close();
    }
  });
});
