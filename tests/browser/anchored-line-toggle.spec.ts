import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E regression coverage for the anchored working-line toggle (Task #363).
 *
 * Covers:
 *   1. Clicking a line on the Line Items tab surfaces the floating pill
 *      labelled "Line N — View translation".
 *   2. Clicking the pill switches to the Translation tab and scrolls the
 *      SAME line's translation row into view; the pill flips to
 *      "View original".
 *   3. Focusing a different line on the Translation tab retargets the pill,
 *      and clicking it lands back on the Line Items tab anchored to that
 *      new line.
 *   4. The pill is hidden on the Avenants and Invoices tabs, and reappears
 *      when returning to Line Items.
 *
 * Seeds a mode_b devis with 25 line items (enough that anchoring is a real
 * scroll, not a no-op) plus a DRAFT translation row.
 *
 * Hermetic: boots ITS OWN app instance on a dedicated port with
 * ENABLE_DEV_LOGIN_FOR_E2E=true. Requires DATABASE_URL — seeding a draft
 * devis_translations row has no public non-AI API.
 */

const APP_PORT = 5162;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const LINE_COUNT = 25;

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
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

interface Seed {
  projectId: number;
  contractorId: number;
  devisId: number;
}

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `LineToggle ${uniq}`,
    code: `LT-${uniq}`,
    clientName: "LT Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `LineToggle Co ${uniq}`,
  });
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `LT-D-${uniq}`,
    descriptionFr: `LineToggle devis ${uniq}`,
    amountHt: "2500.00",
    amountTtc: "3000.00",
    invoicingMode: "mode_b",
  });

  const lineTranslations: Array<Record<string, unknown>> = [];
  for (let n = 1; n <= LINE_COUNT; n++) {
    const description = `Ligne de travaux numéro ${n} — peinture zone ${n}`;
    await postOk<{ id: number }>(api, `/api/devis/${devis.id}/line-items`, {
      lineNumber: n,
      description,
      quantity: "1",
      unit: "u",
      unitPriceHt: "100.00",
      totalHt: "100.00",
    });
    lineTranslations.push({
      lineNumber: n,
      originalDescription: description,
      translation: `Work line number ${n} — painting zone ${n}`,
      edited: false,
    });
  }

  // No public non-AI API creates a translation row; seed a DRAFT one.
  await db.query(
    `INSERT INTO devis_translations
       (devis_id, status, line_translations, header_translated, updated_at)
     VALUES ($1, 'draft', $2::jsonb, '{}'::jsonb, NOW())
     ON CONFLICT (devis_id) DO UPDATE
       SET status = 'draft', line_translations = $2::jsonb, updated_at = NOW()`,
    [devis.id, JSON.stringify(lineTranslations)],
  );

  return { projectId: project.id, contractorId: contractor.id, devisId: devis.id };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM devis_line_contexts WHERE devis_id = $1", [s.devisId]],
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
      console.warn("[anchored-line-toggle cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Anchored working-line toggle (task #363)", () => {
  let app: Awaited<ReturnType<typeof startAppServer>> | null = null;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    app = await startAppServer();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("round-trips line anchors between tabs and hides on Avenants/Invoices", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-linetoggle-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({
      baseURL: APP_URL,
      viewport: { width: 1600, height: 900 },
    });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(context.request, db, uniq);
      const D = s.devisId;

      const page = await context.newPage();
      await page.goto(`${APP_URL}/projets/${s.projectId}`);
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${D}`).click();

      const pill = page.getByTestId(`button-line-toggle-${D}`);

      // mode_b default tab is Line Items; all 25 rows render as anchors.
      // Deliberately COLD: the Translation tab has never been opened, so
      // the first pill click exercises the anchor while translation +
      // line-context queries are still resolving (the real first-use path).
      await expect(page.locator(`#line-anchor-lines-${D}-1`)).toBeVisible();
      await expect(page.locator(`#line-anchor-lines-${D}-${LINE_COUNT}`)).toBeAttached();

      // No pill until a line is picked.
      await expect(pill).toHaveCount(0);

      // -------- 1. Click line 7 → pill appears targeting the translation --------
      await page.locator(`#line-anchor-lines-${D}-7`).click();
      await expect(pill).toBeVisible();
      await expect(pill).toHaveText(/Line 7 — View translation/i);

      // -------- 2. Pill click → Translation tab, same line anchored --------
      await pill.click();
      await expect(page.getByTestId(`section-translation-${D}`)).toBeVisible();
      const translationRow7 = page.getByTestId(`row-translation-${D}-7`);
      await expect(translationRow7).toBeVisible();
      await expect(page.locator(`#line-anchor-translation-${D}-7`)).toBeInViewport();
      // Pill flips direction.
      await expect(pill).toHaveText(/Line 7 — View original/i);

      // -------- 3. Focus a different line on the translation side --------
      await page.getByTestId(`row-translation-${D}-19`).click();
      await expect(pill).toHaveText(/Line 19 — View original/i);

      // Pill click → back to Line Items, anchored on line 19.
      await pill.click();
      await expect(page.locator(`#line-anchor-lines-${D}-19`)).toBeVisible();
      await expect(page.locator(`#line-anchor-lines-${D}-19`)).toBeInViewport();
      await expect(pill).toHaveText(/Line 19 — View translation/i);

      // -------- 4. Pill hidden on Avenants and Invoices tabs --------
      await page.getByTestId(`tab-avenants-${D}`).click();
      await expect(pill).toHaveCount(0);

      await page.getByTestId(`tab-invoices-${D}`).click();
      await expect(pill).toHaveCount(0);

      // Back on Line Items the working line is remembered and the pill returns.
      await page.getByTestId(`tab-lines-${D}`).click();
      await expect(pill).toBeVisible();
      await expect(pill).toHaveText(/Line 19 — View translation/i);
    } finally {
      await cleanup(db, s);
      await db.end().catch(() => {});
      await context.close();
    }
  });
});
