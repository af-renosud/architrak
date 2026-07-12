import { test, expect, type Browser, type BrowserContext, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import http from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E coverage for the Task #279 Archisign rendering-drift operator surfaces.
 *
 * The mock Archisign /create response ships the §3.5.1.1(c) emailRendering
 * echo with subjectApplied=false (the "custom subject was dropped" contract
 * breach). After a full send-to-signer flow the spec asserts all three
 * operator-facing signals:
 *
 *   1. the destructive "Custom email subject not applied" toast fires right
 *      after send (subjectDrift echoed on the /send-to-signer response);
 *   2. the amber "Default subject used" badge renders on the SigningPanel
 *      (data-testid badge-subject-drift-{devisId}, driven by the persisted
 *      devis.archisign_subject_drift_at flag surviving the panel refetch);
 *   3. the devis appears as a row on the read-only ops page at
 *      /admin/ops/archisign-rendering-drift.
 *
 * Outbound Archisign calls are server-side, so the spec is hermetic: it
 * boots ITS OWN app instance on a dedicated port with ARCHISIGN_BASE_URL
 * pointed at an in-test mock HTTP server. The backend echo/persistence
 * logic is already pinned by vitest (archisign-send-to-signer-message.test.ts);
 * this spec covers the browser-visible surfaces only.
 *
 * Requires DATABASE_URL (seeding sign_off_stage / translation / insurance
 * override rows has no public API) and the usual dev deps (tsx).
 */

const APP_PORT = 5141;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

const MOCK_ENVELOPE_ID = 246813;
const MOCK_ACCESS_URL = "https://archisign.example.test/sign/e2e-drift-envelope";

interface MockArchisign {
  port: number;
  createCount: () => number;
  close: () => Promise<void>;
}

/**
 * Mock Archisign that speaks the §3.5.1 wire shape but reports
 * subjectApplied=false in the v1.2 emailRendering echo on /create —
 * i.e. "your custom subject was dropped, the signer got our default".
 */
function startMockArchisign(): Promise<MockArchisign> {
  let createCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/v1/envelopes/create") {
        createCalls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            envelopeId: MOCK_ENVELOPE_ID,
            status: "draft",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            signers: [
              {
                id: 1,
                accessToken: "e2e-drift-access-token",
                accessUrl: MOCK_ACCESS_URL,
                otpDestination: "+33 6 •• •• •• 89",
              },
            ],
            // The §3.5.1.1(c) echo — subject was NOT applied. This is the
            // whole point of the spec: it must surface as toast + badge +
            // admin drift row.
            emailRendering: { subjectApplied: false, bodyApplied: true },
          }),
        );
        return;
      }
      const sendMatch = /^\/api\/v1\/envelopes\/([^/]+)\/send$/.exec(url);
      if (req.method === "POST" && sendMatch) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ envelopeId: sendMatch[1], status: "sent" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `mock archisign: unexpected ${req.method} ${url}` }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mock archisign: no address"));
        return;
      }
      resolve({
        port: addr.port,
        createCount: () => createCalls,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function startAppServer(mockArchisignPort: number): Promise<{
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
      ARCHISIGN_BASE_URL: `http://127.0.0.1:${mockArchisignPort}`,
      ARCHISIGN_API_KEY: "e2e-mock-archisign-key",
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

async function postOk<T = unknown>(
  api: APIRequestContext,
  url: string,
  body: unknown,
): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `${url} failed: ${res.status()} ${await safeText(res)}`).toBe(true);
  return (await res.json()) as T;
}

interface Seed {
  userId: number;
  projectId: number;
  contractorId: number;
  lotId: number;
  devisId: number;
  devisCode: string;
  clientEmail: string;
}

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const email = `e2e-subject-drift-${uniq}@local.test`;
  const login = await postOk<{ id: number }>(api, "/api/auth/dev-login", { email });

  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `Subject Drift ${uniq}`,
    code: `SD-${uniq}`,
    clientName: "Drift Client SARL",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `SD Contractor ${uniq}`,
  });
  const lot = await postOk<{ id: number }>(api, `/api/projects/${project.id}/lots`, {
    lotNumber: "01",
    descriptionFr: "Peinture",
    descriptionUk: "Painting",
  });
  const devisCode = `SD-DEV-${uniq}`;
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode,
    descriptionFr: "Travaux de peinture",
    descriptionUk: "Painting works",
    amountHt: "1000.00",
    amountTtc: "1200.00",
    invoicingMode: "mode_b",
    lotId: lot.id,
  });

  const clientEmail = `drift-client-${uniq}@example.test`;
  // No public API for these transitions/rows — seed directly (same recipe
  // as send-to-signature-journey.spec.ts):
  await db.query(
    `UPDATE projects SET client_contact_name = $1, client_contact_email = $2 WHERE id = $3`,
    ["Claire Client", clientEmail, project.id],
  );
  await db.query(
    `UPDATE devis SET sign_off_stage = 'approved_for_signing', lot_id = $1, description_uk = $2 WHERE id = $3`,
    [lot.id, "Painting works", devis.id],
  );
  await db.query(
    `INSERT INTO devis_translations (devis_id, status) VALUES ($1, 'draft')
     ON CONFLICT (devis_id) DO UPDATE SET status = 'draft'`,
    [devis.id],
  );
  await db.query(
    `INSERT INTO insurance_overrides
       (devis_id, user_id, override_reason, mirror_status_at_override,
        mirror_synced_at_at_override, live_verdict_http_status,
        live_verdict_can_proceed, live_verdict_response, overridden_by_user_email)
     VALUES ($1, $2, 'E2E: mirror-only fallback override', '(unknown)', NOW(), 0, NULL, NULL, $3)`,
    [devis.id, login.id, email],
  );

  return {
    userId: login.id,
    projectId: project.id,
    contractorId: contractor.id,
    lotId: lot.id,
    devisId: devis.id,
    devisCode,
    clientEmail,
  };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM project_communications WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM insurance_overrides WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis_translations WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis_line_items WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM lots WHERE id = $1", [s.lotId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[subject-drift cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Archisign subjectApplied=false drift — toast, badge, admin page (task #279)", () => {
  test("drifted /create echo surfaces on all three operator surfaces", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(300_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const mock = await startMockArchisign();
    let app: Awaited<ReturnType<typeof startAppServer>> | null = null;
    let context: BrowserContext | null = null;
    let seeded: Seed | null = null;

    try {
      app = await startAppServer(mock.port);
      context = await browser.newContext({
        baseURL: APP_URL,
        viewport: { width: 1600, height: 1000 },
      });
      seeded = await seed(context.request, db, uniq);
      const devisId = seeded.devisId;

      const page = await context.newPage();
      await page.goto(`/projets/${seeded.projectId}`);
      await page.getByTestId("tab-devis").click();

      // Expand the devis row so the SigningPanel renders, then drive the
      // two-step compose dialog to a confirmed send.
      await page.getByTestId(`row-devis-toggle-${devisId}`).click();
      const panel = page.getByTestId(`panel-signing-${devisId}`);
      await expect(panel).toBeVisible();
      // No drift badge before anything is sent.
      await expect(page.getByTestId(`badge-subject-drift-${devisId}`)).toHaveCount(0);

      await page.getByTestId(`button-stage-sent_to_client-${devisId}`).click();
      const dialog = page.getByTestId(`dialog-send-to-signer-${devisId}`);
      await expect(dialog).toBeVisible();

      const textarea = page.getByTestId(`textarea-send-message-${devisId}`);
      const message = `Dear Claire, devis ${seeded.devisCode} is ready for signature. Kind regards.`;
      await textarea.fill(message);
      await page.getByTestId(`button-send-to-signer-continue-${devisId}`).click();
      await expect(page.getByTestId(`recap-send-to-signer-${devisId}`)).toBeVisible();
      await page.getByTestId(`button-send-to-signer-confirm-${devisId}`).click();

      // ---- 1. Destructive warning toast (subjectDrift echoed on the
      //         /send-to-signer response) --------------------------------
      // NOTE: the toaster's TOAST_LIMIT is 1, and SigningPanel fires the
      // "Sent for signature" success toast BEFORE the drift warning — so the
      // warning replaces it and is the single toast left standing. That is
      // itself the behaviour under test: the operator's final signal is the
      // warning, not the success message.
      await expect(
        page.getByText("Custom email subject not applied", { exact: true }),
      ).toBeVisible();
      await expect(dialog).toBeHidden();

      // ---- 2. Amber SigningPanel badge (persisted flag, survives the
      //         panel refetch) -------------------------------------------
      const badge = page.getByTestId(`badge-subject-drift-${devisId}`);
      await expect(badge).toBeVisible();
      await expect(badge).toContainText("Default subject used");
      // Envelope details render normally alongside the warning.
      await expect(page.getByTestId(`text-archisign-envelope-${devisId}`)).toContainText(
        String(MOCK_ENVELOPE_ID),
      );

      // Server-side: exactly one /create fired, and the drift flag is
      // persisted on the devis row.
      expect(mock.createCount()).toBe(1);
      const devisRow = await db.query(
        `SELECT archisign_subject_drift_at, sign_off_stage FROM devis WHERE id = $1`,
        [devisId],
      );
      expect(devisRow.rows[0].archisign_subject_drift_at).not.toBeNull();
      expect(devisRow.rows[0].sign_off_stage).toBe("sent_to_client");

      // ---- 3. Read-only ops page lists the drifted devis ----------------
      await page.goto("/admin/ops/archisign-rendering-drift");
      await expect(page.getByTestId("page-admin-archisign-rendering")).toBeVisible();
      const row = page.getByTestId(`row-drift-${devisId}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(seeded.devisCode);
      await expect(row).toContainText(String(MOCK_ENVELOPE_ID));
      await expect(page.getByTestId(`text-drift-at-${devisId}`)).not.toContainText("—");
    } finally {
      try {
        await cleanup(db, seeded);
      } finally {
        await db.end();
        if (context) await context.close();
        if (app) await app.stop();
        await mock.close();
      }
    }
  });
});
