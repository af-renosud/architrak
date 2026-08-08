import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E coverage for the "Unlock" (without retranslation) action on an approved
 * (finalised) devis translation.
 *
 * Covers:
 *   1. A finalised translation shows the Approved badge, the approval notice,
 *      and BOTH "Unlock" and "Re-translate (unlock)" buttons.
 *   2. Clicking "Unlock" returns the translation to the editable state:
 *      badge flips to "Edited", approval notice disappears, per-line
 *      re-translate buttons reappear, and the translated text is UNCHANGED.
 *   3. The "Approve translation" button is available again afterwards.
 *
 * Hermetic: boots ITS OWN app instance on a dedicated port with
 * ENABLE_DEV_LOGIN_FOR_E2E=true. Requires DATABASE_URL — seeding a finalised
 * devis_translations row has no public non-AI API.
 */

const APP_PORT = 5153;
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

const TRANSLATED_TEXT = "Painting of the living-room walls";

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `Unlock ${uniq}`,
    code: `UL-${uniq}`,
    clientName: "UL Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `Unlock Co ${uniq}`,
  });
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `UL-D-${uniq}`,
    descriptionFr: `Unlock devis ${uniq}`,
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
  // No public non-AI API creates a translation row; seed a FINALISED one.
  await db.query(
    `INSERT INTO devis_translations
       (devis_id, status, line_translations, header_translated, approved_at, approved_by_email, updated_at)
     VALUES ($1, 'finalised', $2::jsonb, '{}'::jsonb, NOW(), 'approver@local.test', NOW())
     ON CONFLICT (devis_id) DO UPDATE
       SET status = 'finalised', line_translations = $2::jsonb,
           approved_at = NOW(), approved_by_email = 'approver@local.test'`,
    [
      devis.id,
      JSON.stringify([
        { lineNumber: 1, originalDescription: "Peinture des murs du salon", translation: TRANSLATED_TEXT, edited: true },
      ]),
    ],
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
      console.warn("[translation-unlock cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Translation unlock without retranslation (task #331)", () => {
  let app: Awaited<ReturnType<typeof startAppServer>> | null = null;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    app = await startAppServer();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("unlock keeps text, clears approval, restores editing affordances", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-unlock-${uniq}@local.test`;
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

      // -------- Finalised state --------
      const badge = page.getByTestId(`badge-translation-status-${s.devisId}`);
      await expect(badge).toHaveText(/Approved/);
      await expect(page.getByTestId(`text-translation-approved-${s.devisId}`)).toBeVisible();
      await expect(page.getByTestId(`button-unlock-${s.devisId}`)).toBeVisible();
      await expect(page.getByTestId(`button-retranslate-all-${s.devisId}`)).toBeVisible();
      await expect(page.getByTestId(`button-retranslate-line-${s.devisId}-1`)).toHaveCount(0);
      await expect(page.getByTestId(`input-translation-${s.devisId}-1`)).toHaveValue(TRANSLATED_TEXT);

      // -------- Unlock --------
      await page.getByTestId(`button-unlock-${s.devisId}`).click();
      await expect(page.getByText("Translation unlocked", { exact: true })).toBeVisible({ timeout: 5_000 });

      await expect(badge).toHaveText(/Edited/);
      await expect(page.getByTestId(`text-translation-approved-${s.devisId}`)).toHaveCount(0);
      await expect(page.getByTestId(`button-unlock-${s.devisId}`)).toHaveCount(0);
      await expect(page.getByTestId(`button-retranslate-line-${s.devisId}-1`)).toBeVisible();
      await expect(page.getByTestId(`button-finalise-${s.devisId}`)).toBeVisible();
      // Text preserved — no retranslation happened.
      await expect(page.getByTestId(`input-translation-${s.devisId}-1`)).toHaveValue(TRANSLATED_TEXT);

      // Server state: edited, approval cleared, text intact.
      const res = await context.request.get(`/api/devis/${s.devisId}/translation`);
      expect(res.ok()).toBe(true);
      const row = (await res.json()) as {
        status: string;
        approvedAt: string | null;
        approvedByEmail: string | null;
        lineTranslations: Array<{ translation: string }>;
      };
      expect(row.status).toBe("edited");
      expect(row.approvedAt).toBeNull();
      expect(row.approvedByEmail).toBeNull();
      expect(row.lineTranslations[0]?.translation).toBe(TRANSLATED_TEXT);
    } finally {
      await cleanup(db, s);
      await db.end().catch(() => {});
      await context.close();
    }
  });
});
