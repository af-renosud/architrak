import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E regression coverage for the settle loop behind the anchored line
 * toggle (Task #373): after a jump, the loop keeps re-centering the target
 * row while async content grows the layout — but ANY manual scroll intent
 * from the user (wheel, touch, keyboard, or pointer/scrollbar drag) must
 * cancel the corrections so the page is never hijacked.
 *
 * Covers:
 *   1. Late layout growth ABOVE the anchor is corrected (row stays centred)
 *      when the user does nothing.
 *   2. A mouse-wheel scroll after landing cancels corrections — later layout
 *      growth is NOT re-centred.
 *   3. A pointer press (the scrollbar-drag path: pointerdown/mousedown, no
 *      wheel event) also cancels corrections.
 *
 * Layout growth is simulated by injecting a tall spacer div just above the
 * target anchor, which is exactly what late-loading textareas/context
 * editors do to the document flow.
 *
 * Hermetic: boots ITS OWN app instance on a dedicated port with
 * ENABLE_DEV_LOGIN_FOR_E2E=true. Requires DATABASE_URL — seeding a draft
 * devis_translations row has no public non-AI API.
 */

const APP_PORT = 5171;
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
  expect(res.ok(), `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`).toBe(true);
}

interface Seed {
  projectId: number;
  contractorId: number;
  devisId: number;
}

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `ScrollCancel ${uniq}`,
    code: `SC-${uniq}`,
    clientName: "SC Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `ScrollCancel Co ${uniq}`,
  });
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `SC-D-${uniq}`,
    descriptionFr: `ScrollCancel devis ${uniq}`,
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
      console.warn("[line-toggle-scroll-cancel cleanup] swallowed:", (err as Error).message);
    }
  }
}

/** Distance (px) of the anchor's centre from the viewport centre. */
async function anchorCentreOffset(page: Page, anchorId: string): Promise<number> {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return Number.POSITIVE_INFINITY;
    const r = el.getBoundingClientRect();
    return Math.abs(r.top + r.height / 2 - window.innerHeight / 2);
  }, anchorId);
}

/** Inject a tall spacer just above the anchor to simulate late layout growth. */
async function growLayoutAbove(page: Page, anchorId: string, px: number) {
  await page.evaluate(
    ({ id, px }) => {
      const el = document.getElementById(id);
      if (!el || !el.parentElement) throw new Error(`anchor ${id} not found`);
      const spacer = document.createElement("div");
      spacer.style.height = `${px}px`;
      spacer.setAttribute("data-e2e-spacer", "true");
      el.parentElement.insertBefore(spacer, el);
    },
    { id: anchorId, px },
  );
}

/**
 * Open the devis card, pick a working line, and jump to the Translation tab.
 * Returns as soon as the translation anchor is ATTACHED (not necessarily
 * scrolled into view yet) so callers can act while the settle window is
 * still open; pass `waitInViewport: true` to also wait for the landing.
 */
async function jumpToTranslation(
  page: Page,
  s: Seed,
  lineNumber: number,
  opts: { waitInViewport?: boolean } = {},
) {
  const D = s.devisId;
  await page.goto(`${APP_URL}/projets/${s.projectId}`);
  await page.getByTestId("tab-devis").click();
  await page.getByTestId(`row-devis-toggle-${D}`).click();
  await expect(page.locator(`#line-anchor-lines-${D}-1`)).toBeVisible();

  await page.locator(`#line-anchor-lines-${D}-${lineNumber}`).click();
  const pill = page.getByTestId(`button-line-toggle-${D}`);
  await expect(pill).toHaveText(new RegExp(`Line ${lineNumber} — View translation`, "i"));
  await pill.click();
  const anchorId = `line-anchor-translation-${D}-${lineNumber}`;
  await expect(page.locator(`#${anchorId}`)).toBeAttached();
  if (opts.waitInViewport) {
    await expect(page.locator(`#${anchorId}`)).toBeInViewport();
  }
  return anchorId;
}

test.describe("Line-toggle settle loop cancellation (task #373)", () => {
  let app: Awaited<ReturnType<typeof startAppServer>> | null = null;
  let db: Client;
  let s: Seed | null = null;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    app = await startAppServer();
    db = new Client({ connectionString: databaseUrl! });
    await db.connect();
  });

  test.afterAll(async () => {
    await cleanup(db, s);
    await db.end().catch(() => {});
    await app?.stop();
  });

  test("re-centres on late layout growth, but manual scroll input cancels corrections", async ({ browser }) => {
    test.setTimeout(150_000);
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const context = await browser.newContext({
      baseURL: APP_URL,
      viewport: { width: 1600, height: 900 },
    });
    try {
      await devLogin(context.request, `e2e-scrollcancel-${uniq}@local.test`);
      s = await seed(context.request, db, uniq);
      const page = await context.newPage();

      // -------- 1. No user input → late growth above the anchor is corrected --------
      let anchorId = await jumpToTranslation(page, s, 20);
      // Grow the layout while the settle window is still open (< 600ms quiet).
      await growLayoutAbove(page, anchorId, 800);
      // The loop must pull the anchor back to (roughly) centre.
      await expect
        .poll(() => anchorCentreOffset(page, anchorId), { timeout: 3000 })
        .toBeLessThan(150);

      // -------- 2. Wheel scroll cancels corrections --------
      await page.reload();
      anchorId = await jumpToTranslation(page, s, 20, { waitInViewport: true });
      await page.mouse.wheel(0, -300); // user scrolls away
      await page.waitForTimeout(200);
      const afterWheel = await anchorCentreOffset(page, anchorId);
      await growLayoutAbove(page, anchorId, 800);
      await page.waitForTimeout(1500); // give a (wrongly alive) loop time to hijack
      const afterGrowth = await anchorCentreOffset(page, anchorId);
      // The anchor moved down by ~800px and must NOT have been re-centred.
      expect(afterGrowth).toBeGreaterThan(afterWheel + 400);

      // -------- 3. Pointer press (scrollbar-drag path) cancels corrections --------
      await page.reload();
      anchorId = await jumpToTranslation(page, s, 20, { waitInViewport: true });
      // Simulate the start of a scrollbar drag: pointerdown/mousedown only —
      // no wheel/touch/key events are emitted by a scrollbar drag.
      await page.evaluate(() => {
        window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      });
      const beforePointerGrowth = await anchorCentreOffset(page, anchorId);
      await growLayoutAbove(page, anchorId, 800);
      await page.waitForTimeout(1500);
      const afterPointerGrowth = await anchorCentreOffset(page, anchorId);
      expect(afterPointerGrowth).toBeGreaterThan(beforePointerGrowth + 400);
    } finally {
      await context.close();
    }
  });
});
