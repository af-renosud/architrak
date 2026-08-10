import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E coverage for the at-a-glance devis readiness strip (Task #374).
 *
 * Covers:
 *   1. The 4-step strip (Review · Translation · Ready · Signature) renders
 *      on the collapsed devis row, fed by the batch readiness endpoint.
 *   2. A mode_b devis with a DRAFT translation at approved_for_signing
 *      shows Review=Approved, Translation=Draft, Ready=Blocked (with the
 *      finalisation blocker in the tooltip), Signature=Not sent.
 *   3. A mode_a devis at `received` with no translation shows
 *      Translation="Missing" (a translated PDF is required for both modes
 *      at send time — the envelope PDF is the translation).
 *   4. The generic PENDING status chip is de-emphasised (hidden) once the
 *      strip carries the state.
 *
 * Hermetic: boots ITS OWN app instance on a dedicated port with
 * ENABLE_DEV_LOGIN_FOR_E2E=true. Requires DATABASE_URL — seeding a draft
 * devis_translations row and the sign-off stage has no public non-AI API.
 */

const APP_PORT = 5173;
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
  devisBId: number; // mode_b, approved_for_signing, draft translation
  devisAId: number; // mode_a, received
}

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `Readiness ${uniq}`,
    code: `RD-${uniq}`,
    clientName: "RD Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `Readiness Co ${uniq}`,
  });
  const devisB = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `RD-B-${uniq}`,
    descriptionFr: `Readiness mode_b devis ${uniq}`,
    amountHt: "1000.00",
    amountTtc: "1200.00",
    invoicingMode: "mode_b",
  });
  const devisA = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `RD-A-${uniq}`,
    descriptionFr: `Readiness mode_a devis ${uniq}`,
    amountHt: "500.00",
    amountTtc: "600.00",
    invoicingMode: "mode_a",
  });

  // Stage + translation state have no public non-AI seeding API.
  await db.query(
    `UPDATE devis SET sign_off_stage = 'approved_for_signing' WHERE id = $1`,
    [devisB.id],
  );
  await db.query(
    `INSERT INTO devis_translations
       (devis_id, status, line_translations, header_translated, updated_at)
     VALUES ($1, 'draft', '[]'::jsonb, '{}'::jsonb, NOW())
     ON CONFLICT (devis_id) DO UPDATE
       SET status = 'draft', updated_at = NOW()`,
    [devisB.id],
  );

  return {
    projectId: project.id,
    contractorId: contractor.id,
    devisBId: devisB.id,
    devisAId: devisA.id,
  };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM devis_translations WHERE devis_id = ANY($1::int[])", [[s.devisBId, s.devisAId]]],
    ["DELETE FROM devis WHERE id = ANY($1::int[])", [[s.devisBId, s.devisAId]]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[devis-readiness-strip cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Devis readiness strip (task #374)", () => {
  let app: Awaited<ReturnType<typeof startAppServer>> | null = null;

  test.beforeAll(async () => {
    test.setTimeout(150_000);
    app = await startAppServer();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("renders the 4-step strip with correct states and hides the PENDING chip", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-readiness-${uniq}@local.test`;
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
      const B = s.devisBId;
      const A = s.devisAId;

      const page = await context.newPage();
      await page.goto(`${APP_URL}/projets/${s.projectId}`);
      await page.getByTestId("tab-devis").click();

      // -------- Mode B devis: approved + draft translation --------
      await expect(page.getByTestId(`readiness-strip-${B}`)).toBeVisible();
      await expect(page.getByTestId(`readiness-review-${B}`)).toHaveText(/Approved/i);
      await expect(page.getByTestId(`readiness-translation-${B}`)).toHaveText(/Draft/i);
      await expect(page.getByTestId(`readiness-ready-${B}`)).toHaveText(/Blocked/i);
      await expect(page.getByTestId(`readiness-signature-${B}`)).toHaveText(/Not sent/i);

      // Blocked tooltip lists the finalisation blocker.
      await page.getByTestId(`readiness-ready-${B}`).hover();
      await expect(
        page.getByText(/Translation not finalised/i).first(),
      ).toBeVisible();

      // -------- Mode A devis: received, no translation required --------
      await expect(page.getByTestId(`readiness-strip-${A}`)).toBeVisible();
      await expect(page.getByTestId(`readiness-review-${A}`)).toHaveText(/Received/i);
      await expect(page.getByTestId(`readiness-translation-${A}`)).toHaveText(/Missing/i);
      await expect(page.getByTestId(`readiness-ready-${A}`)).toHaveText(/Blocked/i);

      // -------- PENDING chip de-emphasised on both rows --------
      await expect(page.getByTestId(`card-devis-${B}`).getByText("PENDING", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId(`card-devis-${A}`).getByText("PENDING", { exact: true })).toHaveCount(0);
    } finally {
      await cleanup(db, s);
      await db.end().catch(() => {});
      await context.close();
    }
  });
});
