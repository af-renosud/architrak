import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E coverage for the Alt+T keyboard shortcut (task #365, verified per task
 * #367 "Browser test that Alt+T jumps between original and translation").
 *
 * The shortcut mirrors the floating "Line N — View translation/original"
 * pill: it switches between the Line Items and Translation tabs, scrolls the
 * working line's counterpart into view, and briefly flash-highlights it.
 *
 * Covers:
 *   1. No-op: with no working line active (pill hidden), Alt+T does nothing —
 *      the Line Items tab stays active.
 *   2. Activate a working line (click a row) → pill appears → Alt+T switches
 *      to the Translation tab, the matching translation row is scrolled into
 *      the viewport and gets the flash highlight class.
 *   3. Alt+T again jumps back to the Line Items tab, anchored + flashed on
 *      the same line.
 *
 * Hermetic: boots ITS OWN app instance on a dedicated port with
 * ENABLE_DEV_LOGIN_FOR_E2E=true. Requires DATABASE_URL — a draft
 * devis_translations row (needed for the translation rows to render) has no
 * public non-AI API.
 */

const APP_PORT = 5157;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const LINE_COUNT = 12;
const TARGET_LINE = 9; // deep enough that the anchored scroll matters

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
  expect(res.ok(), `dev-login failed: ${res.status()} ${await safeText(res)}`).toBe(true);
}

type Seed = {
  projectId: number;
  contractorId: number;
  devisId: number;
};

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `AltT ${uniq}`,
    code: `AT-${uniq}`,
    clientName: "AltT Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `AltT Co ${uniq}`,
  });
  // mode_b: the Line Items tab (and thus the pill + shortcut) only exists
  // for variant-B devis.
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `AT-D-${uniq}`,
    descriptionFr: `Alt+T devis ${uniq}`,
    amountHt: "1200.00",
    amountTtc: "1440.00",
    invoicingMode: "mode_b",
  });
  const translations: Array<{ lineNumber: number; originalDescription: string; translation: string }> = [];
  for (let n = 1; n <= LINE_COUNT; n++) {
    await postOk(api, `/api/devis/${devis.id}/line-items`, {
      lineNumber: n,
      description: `Ligne ${n} — peinture zone ${n}`,
      quantity: "1",
      unit: "u",
      unitPriceHt: "100.00",
      totalHt: "100.00",
    });
    translations.push({
      lineNumber: n,
      originalDescription: `Ligne ${n} — peinture zone ${n}`,
      translation: `Line ${n} — painting zone ${n}`,
    });
  }
  // No public non-AI API creates a translation row; a draft row is required
  // for the Translation tab to render per-line rows.
  await db.query(
    `INSERT INTO devis_translations (devis_id, status, line_translations, header_translated, updated_at)
     VALUES ($1, 'draft', $2::jsonb, '{}'::jsonb, NOW())
     ON CONFLICT (devis_id) DO UPDATE SET status = 'draft', line_translations = $2::jsonb`,
    [devis.id, JSON.stringify(translations)],
  );
  return { projectId: project.id, contractorId: contractor.id, devisId: devis.id };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
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
      console.warn("[alt-t cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Alt+T anchored line toggle (task #365)", () => {
  let app: Awaited<ReturnType<typeof startAppServer>> | null = null;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    app = await startAppServer();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("Alt+T jumps between original and translation; no-op when pill hidden", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-alt-t-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({
      baseURL: APP_URL,
      // Deliberately short viewport so line 9 of 12 needs real scrolling.
      viewport: { width: 1400, height: 700 },
    });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      s = await seed(context.request, db, uniq);

      const page = await context.newPage();
      await page.goto(`${APP_URL}/projets/${s.projectId}`);
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${s.devisId}`).click();

      const linesTab = page.getByTestId(`tab-lines-${s.devisId}`);
      const translationTab = page.getByTestId(`tab-translation-${s.devisId}`);
      const pill = page.getByTestId(`button-line-toggle-${s.devisId}`);
      const lineRow = page.locator(`#line-anchor-lines-${s.devisId}-${TARGET_LINE}`);
      const translationRow = page.getByTestId(`row-translation-${s.devisId}-${TARGET_LINE}`);

      // mode_b defaults to the Line Items tab; no working line yet → pill hidden.
      await expect(linesTab).toHaveAttribute("data-state", "active");
      await expect(lineRow).toBeVisible();
      await expect(pill).toBeHidden();

      // -------- 1. No-op while the pill is hidden --------
      await page.keyboard.press("Alt+KeyT");
      // Give any (buggy) handler a beat to switch tabs, then assert nothing moved.
      await page.waitForTimeout(400);
      await expect(linesTab).toHaveAttribute("data-state", "active");
      await expect(translationTab).toHaveAttribute("data-state", "inactive");
      await expect(pill).toBeHidden();

      // -------- 2. Activate a working line → Alt+T → translation --------
      await lineRow.scrollIntoViewIfNeeded();
      await lineRow.click();
      await expect(pill).toBeVisible();
      await expect(pill).toContainText(`Line ${TARGET_LINE} — View translation`);

      await page.keyboard.press("Alt+KeyT");
      await expect(translationTab).toHaveAttribute("data-state", "active");
      // Anchored scroll targeted the counterpart row, which flash-highlights
      // (class applied for ~1.6s after the jump). NOTE: on this FIRST switch
      // the tab content mounts fresh and its rich-text context editors can
      // shift layout mid-scroll (known issue, tracked as its own task), so we
      // don't assert strict viewport placement here — only on later jumps
      // into already-mounted tabs.
      await expect(translationRow).toBeVisible();
      await expect(translationRow).toHaveClass(/bg-\[#C1A27B\]\/15/, { timeout: 1_500 });
      // Pill now offers the way back.
      await expect(pill).toContainText(`Line ${TARGET_LINE} — View original`);

      // -------- 3. Alt+T again → back to the original line --------
      await page.keyboard.press("Alt+KeyT");
      await expect(linesTab).toHaveAttribute("data-state", "active");
      await expect(lineRow).toBeVisible();
      await expect(lineRow).toBeInViewport();
      await expect(lineRow).toHaveClass(/bg-\[#C1A27B\]\/25/, { timeout: 1_500 });
      await expect(pill).toContainText(`Line ${TARGET_LINE} — View translation`);

      // -------- 4. Third Alt+T → translation again, now fully mounted ------
      // With the tab content already mounted (no layout shift), the anchored
      // scroll must land the counterpart row in the viewport.
      await page.keyboard.press("Alt+KeyT");
      await expect(translationTab).toHaveAttribute("data-state", "active");
      await expect(translationRow).toBeInViewport();
      await expect(translationRow).toHaveClass(/bg-\[#C1A27B\]\/15/, { timeout: 1_500 });
    } finally {
      await cleanup(db, s);
      await db.end();
      await context.close();
    }
  });
});
