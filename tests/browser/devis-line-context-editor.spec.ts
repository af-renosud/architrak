import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E coverage for the per-line rich-text "Context" editors in the devis
 * translation section (task #296 UI, verified in a real browser per task
 * "Confirm the new per-line context boxes save and render in a real browser").
 *
 * Covers:
 *   1. Typing into a context box → blur → "Saved" indicator, content
 *      persisted (verified via GET /line-contexts AND a full page reload).
 *   2. Inserting an https:// link through the toolbar prompt → anchor
 *      rendered in the editor and the link mark persisted.
 *   3. A javascript: URL entered in the link prompt is rejected with the
 *      "Invalid link" toast and never persisted.
 *   4. Concurrent-edit handling: a competing PUT bumps the server revision;
 *      the browser's next save hits 409, rebases once (toast "Context edited
 *      elsewhere"), retries, and the browser's content wins.
 *
 * Hermetic: boots ITS OWN app instance on a dedicated port with
 * ENABLE_DEV_LOGIN_FOR_E2E=true (the shared :5000 workflow does not set it).
 * Requires DATABASE_URL — seeding a draft devis_translations row (which the
 * translation section needs to render the per-line editors) has no public
 * non-AI API.
 */

const APP_PORT = 5147;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

async function startAppServer(): Promise<{
  proc: ChildProcessWithoutNullStreams;
  logs: () => string;
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
  try {
    const res = await fetch(`${APP_URL}/healthz`);
    if (!res.ok) throw new Error(`healthz not ok: ${res.status}`);
  } catch (err) {
    throw new Error(
      `app server never became healthy (${lastErr}; ${(err as Error).message}). Output tail:\n${output.join("").slice(-3000)}`,
    );
  }
  return {
    proc,
    logs: () => output.join(""),
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
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

interface Seed {
  projectId: number;
  contractorId: number;
  devisId: number;
  lineItemId: number;
}

type ContextRow = {
  devisLineItemId: number;
  revision: number;
  document: { type: string; content?: unknown[] };
};

async function getContexts(api: APIRequestContext, devisId: number): Promise<ContextRow[]> {
  const res = await api.get(`/api/devis/${devisId}/line-contexts`);
  expect(res.ok(), `GET line-contexts failed: ${res.status()}`).toBe(true);
  return ((await res.json()) as { contexts: ContextRow[] }).contexts;
}

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `LineCtx ${uniq}`,
    code: `LC-${uniq}`,
    clientName: "LC Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `LineCtx Co ${uniq}`,
  });
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `LC-D-${uniq}`,
    descriptionFr: `Line context devis ${uniq}`,
    amountHt: "100.00",
    amountTtc: "120.00",
    invoicingMode: "mode_a",
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
  // only renders per-line context editors in draft/edited state.
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
      console.warn("[line-context cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Per-line context editor (task #296)", () => {
  let app: Awaited<ReturnType<typeof startAppServer>> | null = null;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    app = await startAppServer();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("save + reload persistence, link toolbar, javascript: rejection, 409 rebase", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-line-ctx-${uniq}@local.test`;
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

      const editor = page.getByTestId(`input-context-${s.devisId}-1`);
      const status = page.getByTestId(`status-context-save-${s.devisId}-1`);
      await expect(editor).toBeVisible();

      // -------- 1. Type, blur, "Saved", persisted --------
      const ctxText = `Client requested matte finish ${uniq}`;
      await editor.click();
      await page.keyboard.type(ctxText);
      // Blur (click the translation textarea) → immediate flush.
      await page.getByTestId(`input-translation-${s.devisId}-1`).click();
      await expect(status).toHaveText(/Saved/, { timeout: 10_000 });

      let rows = await getContexts(context.request, s.devisId);
      const row1 = rows.find((r) => r.devisLineItemId === s!.lineItemId);
      expect(row1?.revision).toBe(1);
      expect(JSON.stringify(row1?.document)).toContain(ctxText);

      // Reload → content renders back into the editor.
      await page.reload();
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${s.devisId}`).click();
      await page.getByTestId(`tab-translation-${s.devisId}`).click();
      await expect(editor).toBeVisible();
      await expect(editor).toContainText(ctxText);

      // -------- 2. Insert an https link via the toolbar --------
      await editor.click();
      await page.keyboard.press("ControlOrMeta+a");
      page.once("dialog", (d) => void d.accept("https://example.com/spec"));
      await page.getByTestId(`button-context-link-${s.devisId}-1`).click();
      await expect(editor.locator('a[href="https://example.com/spec"]')).toBeVisible();
      // The toolbar action saves immediately.
      await expect(status).toHaveText(/Saved/, { timeout: 10_000 });
      rows = await getContexts(context.request, s.devisId);
      const linkedDoc = JSON.stringify(rows.find((r) => r.devisLineItemId === s!.lineItemId)?.document);
      expect(linkedDoc).toContain('"https://example.com/spec"');

      // -------- 3. javascript: link is rejected --------
      await editor.click();
      await page.keyboard.press("ControlOrMeta+a");
      page.once("dialog", (d) => void d.accept("javascript:alert(1)"));
      await page.getByTestId(`button-context-link-${s.devisId}-1`).click();
      await expect(page.getByText("Invalid link", { exact: true })).toBeVisible({ timeout: 5_000 });
      rows = await getContexts(context.request, s.devisId);
      expect(
        JSON.stringify(rows.find((r) => r.devisLineItemId === s!.lineItemId)?.document),
      ).not.toContain("javascript:");

      // -------- 4. Concurrent edit → 409 → single rebase-and-retry --------
      // Bump the server revision behind the browser's back with a competing PUT.
      const current = (await getContexts(context.request, s.devisId)).find(
        (r) => r.devisLineItemId === s!.lineItemId,
      )!;
      const competing = await context.request.put(
        `/api/devis/${s.devisId}/line-contexts/${s.lineItemId}`,
        {
          data: {
            document: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Competing edit from another window" }] },
              ],
            },
            baseRevision: current.revision,
          },
        },
      );
      expect(competing.ok(), `competing PUT failed: ${competing.status()}`).toBe(true);

      // Browser edits with its now-stale baseRevision → 409 → rebase toast,
      // retry succeeds and the browser's content wins (last-writer-wins).
      const winningText = ` browser wins ${uniq}`;
      await editor.click();
      await page.keyboard.press("End");
      await page.keyboard.type(winningText);
      await page.getByTestId(`input-translation-${s.devisId}-1`).click();
      await expect(page.getByText("Context edited elsewhere", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(status).toHaveText(/Saved/, { timeout: 10_000 });

      rows = await getContexts(context.request, s.devisId);
      const finalRow = rows.find((r) => r.devisLineItemId === s!.lineItemId)!;
      const finalDoc = JSON.stringify(finalRow.document);
      expect(finalDoc).toContain(winningText.trim());
      expect(finalDoc).not.toContain("Competing edit from another window");
      // draft rev1 → link rev2 → competing rev3 → rebased browser save rev4.
      expect(finalRow.revision).toBeGreaterThanOrEqual(4);
    } finally {
      await cleanup(db, s);
      await db.end();
      await context.close();
    }
  });
});
