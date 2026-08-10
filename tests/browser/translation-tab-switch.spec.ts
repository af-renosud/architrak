import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E regression coverage for Task 364 (lost translation edits and false
 * "edited elsewhere" conflicts when switching tabs), per task #369.
 *
 * Flow under test:
 *   1. Type a line translation AND a rich-text context note, then switch to
 *      the Line Items tab WITHOUT blurring first — the unmount flush must
 *      persist both.
 *   2. Switch back to the Translation tab — both values render back.
 *   3. Full page reload — both values persisted server-side.
 *   4. At no point does an "edited elsewhere" / "changed elsewhere" conflict
 *      toast (or conflict save-state) appear.
 *
 * Hermetic: boots ITS OWN app instance with ENABLE_DEV_LOGIN_FOR_E2E=true.
 * Requires DATABASE_URL — seeding a draft devis_translations row (needed for
 * the translation section to be editable) has no public non-AI API.
 */

const APP_PORT = 5167;
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
        if (proc.exitCode !== null) return resolve();
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        }, 5_000);
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
  expect(res.ok(), `dev-login failed: ${res.status()} ${await safeText(res)}`).toBe(true);
}

type Seed = {
  projectId: number;
  contractorId: number;
  devisId: number;
  lineItemId: number;
};

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `TabSwitch ${uniq}`,
    code: `TS-${uniq}`,
    clientName: "TS Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `TabSwitch Co ${uniq}`,
  });
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `TS-D-${uniq}`,
    descriptionFr: `Tab switch devis ${uniq}`,
    amountHt: "100.00",
    amountTtc: "120.00",
    // mode_b: the "Line Items" tab only renders for mode B devis, and the
    // whole point of this test is switching between it and Translation.
    invoicingMode: "mode_b",
  });
  const line = await postOk<{ id: number }>(api, `/api/devis/${devis.id}/line-items`, {
    lineNumber: 1,
    description: "Peinture des murs du salon",
    quantity: "1",
    unit: "u",
    unitPriceHt: "100.00",
    totalHt: "100.00",
  });
  // No public non-AI API creates a translation row; the translation section
  // is only editable in draft/edited state.
  await db.query(
    `INSERT INTO devis_translations (devis_id, status, line_translations, header_translated, updated_at)
     VALUES ($1, 'draft', $2::jsonb, '{}'::jsonb, NOW())
     ON CONFLICT (devis_id) DO UPDATE SET status = 'draft', line_translations = $2::jsonb`,
    [
      devis.id,
      JSON.stringify([
        {
          lineNumber: 1,
          originalDescription: "Peinture des murs du salon",
          translation: "Painting of the living-room walls",
        },
      ]),
    ],
  );
  return { projectId: project.id, contractorId: contractor.id, devisId: devis.id, lineItemId: line.id };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM devis_line_context_assets WHERE devis_line_item_id = $1", [s.lineItemId]],
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
      console.warn("[tab-switch cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Translation edits survive tab switching (task #364)", () => {
  let app: Awaited<ReturnType<typeof startAppServer>> | null = null;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    app = await startAppServer();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("line translation + context note persist across tab switch and reload with no conflict toast", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-tab-switch-${uniq}@local.test`;
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
      // A conflict toast at ANY point fails the test — assert its absence at
      // each checkpoint via this locator (covers both conflict toast titles
      // and the inline "Edited elsewhere" save-state indicator).
      const conflictIndicator = page.getByText(/edited elsewhere|changed elsewhere/i);

      const openTranslationTab = async () => {
        await page.getByTestId("tab-devis").click();
        await page.getByTestId(`row-devis-toggle-${s!.devisId}`).click();
        await page.getByTestId(`tab-translation-${s!.devisId}`).click();
      };

      await page.goto(`${APP_URL}/projets/${s.projectId}`);
      await openTranslationTab();

      const translationBox = page.getByTestId(`input-translation-${s.devisId}-1`);
      const contextEditor = page.getByTestId(`input-context-${s.devisId}-1`);
      await expect(translationBox).toBeVisible();
      await expect(contextEditor).toBeVisible();

      // -------- 1. Edit translation + context note, then switch tabs
      //            WITHOUT blurring (the unmount flush must persist both) ----
      const translationText = `Painting of the living-room walls, matte ${uniq}`;
      const contextText = `Client wants two coats ${uniq}`;

      await translationBox.click();
      await translationBox.fill(translationText);

      await contextEditor.click();
      await page.keyboard.type(contextText);

      // Switch straight to the Line Items tab — no blur, no waiting for the
      // debounce. This unmounts the translation section.
      await page.getByTestId(`tab-lines-${s.devisId}`).click();
      await expect(translationBox).toBeHidden();
      await expect(conflictIndicator).toHaveCount(0);

      // -------- 2. Switch back — both values render back ------------------
      await page.getByTestId(`tab-translation-${s.devisId}`).click();
      await expect(translationBox).toBeVisible();
      await expect(translationBox).toHaveValue(translationText, { timeout: 10_000 });
      await expect(contextEditor).toContainText(contextText, { timeout: 10_000 });
      await expect(conflictIndicator).toHaveCount(0);

      // -------- 3. Persisted server-side (poll until the flushed saves land)
      await expect
        .poll(
          async () => {
            const res = await context.request.get(`/api/devis/${s!.devisId}/translation`);
            if (!res.ok()) return "";
            return JSON.stringify(await res.json());
          },
          { timeout: 15_000 },
        )
        .toContain(translationText);
      await expect
        .poll(
          async () => {
            const res = await context.request.get(`/api/devis/${s!.devisId}/line-contexts`);
            if (!res.ok()) return "";
            return JSON.stringify(await res.json());
          },
          { timeout: 15_000 },
        )
        .toContain(contextText);

      // -------- 4. Full reload — everything comes back from the server ----
      await page.reload();
      await openTranslationTab();
      await expect(translationBox).toBeVisible();
      await expect(translationBox).toHaveValue(translationText, { timeout: 10_000 });
      await expect(contextEditor).toContainText(contextText, { timeout: 10_000 });
      await expect(conflictIndicator).toHaveCount(0);
    } finally {
      await cleanup(db, s);
      await db.end();
      await context.close();
    }
  });
});
