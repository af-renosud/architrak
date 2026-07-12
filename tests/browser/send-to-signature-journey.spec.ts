import { test, expect, type Browser, type BrowserContext, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import http from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E coverage for the full send-to-signature journey (task #257 wiring):
 *
 *   stepper click on "Sent to Client"
 *     → OPEN_SIGNING_SEND_EVENT is dispatched (window CustomEvent — the
 *       exact wiring unit tests cannot exercise)
 *     → SigningPanel scrolls into view and opens the two-step compose dialog
 *     → short-message gating (Continuer disabled + min-length warning)
 *     → valid message → recap (recipient / devis ref / message echo)
 *     → back-to-compose keeps the draft
 *     → confirm → POST /send-to-signer → Archisign /create + /send fire
 *     → stage advances to sent_to_client, envelope details render
 *     → contextEmail dispatched via the E2E fake Gmail (status "sent",
 *       so NO destructive "E-mail de contexte NON envoyé" toast).
 *
 * Outbound Archisign calls are server-side, so they cannot be intercepted
 * from the browser. This spec therefore boots ITS OWN app instance on a
 * dedicated port with ARCHISIGN_BASE_URL pointed at an in-test mock HTTP
 * server that speaks the §3.5.1 wire shape. Everything else (DB, dev login,
 * fake Gmail) matches the standard E2E setup. The spec is hermetic: it does
 * NOT use the shared :5000 dev server and never touches the real Archisign.
 *
 * Requires DATABASE_URL (seeding sign_off_stage / translation / insurance
 * override rows has no public API) and the usual dev deps (tsx).
 */

const APP_PORT = 5137;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

interface ArchisignCreateCall {
  path: string;
  body: Record<string, unknown>;
}

interface MockArchisign {
  port: number;
  createCalls: ArchisignCreateCall[];
  sendPaths: string[];
  close: () => Promise<void>;
}

const MOCK_ENVELOPE_ID = 987654;
const MOCK_ACCESS_URL = "https://archisign.example.test/sign/e2e-envelope";
const MOCK_OTP_DESTINATION = "+33 6 •• •• •• 89";

function startMockArchisign(): Promise<MockArchisign> {
  const createCalls: ArchisignCreateCall[] = [];
  const sendPaths: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/v1/envelopes/create") {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* keep {} */
        }
        createCalls.push({ path: url, body });
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
                accessToken: "e2e-access-token",
                accessUrl: MOCK_ACCESS_URL,
                otpDestination: MOCK_OTP_DESTINATION,
              },
            ],
          }),
        );
        return;
      }
      const sendMatch = /^\/api\/v1\/envelopes\/([^/]+)\/send$/.exec(url);
      if (req.method === "POST" && sendMatch) {
        sendPaths.push(url);
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
        createCalls,
        sendPaths,
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
  const email = `e2e-send-journey-${uniq}@local.test`;
  const login = await postOk<{ id: number }>(api, "/api/auth/dev-login", { email });

  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `Signature Journey ${uniq}`,
    code: `SJ-${uniq}`,
    clientName: "Journey Client SARL",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `SJ Contractor ${uniq}`,
  });
  const lot = await postOk<{ id: number }>(api, `/api/projects/${project.id}/lots`, {
    lotNumber: "01",
    descriptionFr: "Plomberie",
    descriptionUk: "Plumbing",
  });
  const devisCode = `SJ-DEV-${uniq}`;
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode,
    descriptionFr: "Travaux de plomberie salle de bain",
    descriptionUk: "Bathroom plumbing works",
    amountHt: "1000.00",
    amountTtc: "1200.00",
    invoicingMode: "mode_b",
    lotId: lot.id,
  });

  const clientEmail = `journey-client-${uniq}@example.test`;
  // No public API for these transitions/rows — seed directly:
  //   - client contact (recap + context email recipient)
  //   - sign_off_stage=approved_for_signing (the sendable stage)
  //   - lot + English description (stepper unblock, belt-and-braces in case
  //     the create endpoint strips them)
  //   - a 'draft' translation row (pdf_not_ready gate)
  //   - an insurance override row (the mirror-only fallback blocks
  //     overridably for a contractor with no ArchiDoc mirror data).
  await db.query(
    `UPDATE projects SET client_contact_name = $1, client_contact_email = $2 WHERE id = $3`,
    ["Claire Client", clientEmail, project.id],
  );
  await db.query(
    `UPDATE devis SET sign_off_stage = 'approved_for_signing', lot_id = $1, description_uk = $2 WHERE id = $3`,
    [lot.id, "Bathroom plumbing works", devis.id],
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
      console.warn("[send-journey cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Send-to-signature journey — stepper → SigningPanel dialog → envelope (task #257)", () => {
  test("two-step dialog happy path with short-message gating, envelope creation and context email", async ({
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

      // Expand the devis row so the stepper + SigningPanel render.
      await page.getByTestId(`row-devis-toggle-${devisId}`).click();
      const panel = page.getByTestId(`panel-signing-${devisId}`);
      await expect(panel).toBeVisible();
      // Sanity: the sendable empty-state renders (approved_for_signing, no envelope yet).
      await expect(page.getByTestId(`text-signing-empty-${devisId}`)).toBeVisible();

      // ---- 1. Stepper click dispatches OPEN_SIGNING_SEND_EVENT ------------
      // The "Sent to Client" stage button must NOT PATCH the stage; it opens
      // the SigningPanel's compose dialog and scrolls the panel into view.
      await page.getByTestId(`button-stage-sent_to_client-${devisId}`).click();
      const dialog = page.getByTestId(`dialog-send-to-signer-${devisId}`);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Étape 1 / 2 — Message au client");

      // The panel was scrolled into view by the event handler.
      await expect(panel).toBeInViewport();

      // Stage must still be approved_for_signing server-side (no PATCH fired).
      const stageAfterClick = await db.query(
        "SELECT sign_off_stage FROM devis WHERE id = $1",
        [devisId],
      );
      expect(stageAfterClick.rows[0].sign_off_stage).toBe("approved_for_signing");

      // ---- 2. Pre-filled template ----------------------------------------
      const textarea = page.getByTestId(`textarea-send-message-${devisId}`);
      await expect(textarea).toBeVisible();
      const prefilled = await textarea.inputValue();
      expect(prefilled).toContain("Bonjour Claire Client");
      expect(prefilled).toContain(seeded.devisCode);

      // ---- 3. Short-message gating ----------------------------------------
      const continueBtn = page.getByTestId(`button-send-to-signer-continue-${devisId}`);
      await textarea.fill("Trop court."); // 11 chars < 20 min
      await expect(continueBtn).toBeDisabled();
      await expect(page.getByTestId(`text-send-message-min-${devisId}`)).toContainText(
        "Minimum 20 caractères requis",
      );

      // ---- 4. Valid message → recap ----------------------------------------
      const message = `Bonjour Claire, le devis ${seeded.devisCode} est prêt pour signature. Cordialement.`;
      await textarea.fill(message);
      await expect(continueBtn).toBeEnabled();
      await continueBtn.click();

      await expect(dialog).toContainText("Étape 2 / 2 — Vérification avant envoi");
      const recap = page.getByTestId(`recap-send-to-signer-${devisId}`);
      await expect(recap).toBeVisible();
      await expect(page.getByTestId(`text-recap-recipient-${devisId}`)).toContainText(
        "Claire Client",
      );
      await expect(page.getByTestId(`text-recap-recipient-${devisId}`)).toContainText(
        seeded.clientEmail,
      );
      await expect(page.getByTestId(`text-recap-devis-${devisId}`)).toContainText(
        seeded.devisCode,
      );
      await expect(page.getByTestId(`text-recap-message-${devisId}`)).toContainText(message);

      // ---- 5. Back keeps the draft, forward returns to recap ---------------
      await page.getByTestId(`button-send-to-signer-back-${devisId}`).click();
      await expect(textarea).toBeVisible();
      expect(await textarea.inputValue()).toBe(message);
      await continueBtn.click();
      await expect(recap).toBeVisible();

      // ---- 6. Confirm → envelope created + context email sent --------------
      await page.getByTestId(`button-send-to-signer-confirm-${devisId}`).click();

      // Success toast, and NO destructive context-email failure toast (the
      // fake Gmail path reports "sent").
      await expect(page.getByText("Envoyé à la signature")).toBeVisible();
      await expect(page.getByText("E-mail de contexte NON envoyé")).toHaveCount(0);
      await expect(dialog).toBeHidden();

      // Panel refreshes with the envelope details from /create.
      await expect(page.getByTestId(`badge-archisign-status-${devisId}`)).toContainText(
        "Envoyée",
      );
      await expect(page.getByTestId(`text-archisign-envelope-${devisId}`)).toContainText(
        String(MOCK_ENVELOPE_ID),
      );
      await expect(page.getByTestId(`link-archisign-access-${devisId}`)).toHaveAttribute(
        "href",
        MOCK_ACCESS_URL,
      );
      await expect(page.getByTestId(`text-archisign-otp-${devisId}`)).toContainText(
        MOCK_OTP_DESTINATION,
      );
      await expect(
        page.getByTestId(`text-archisign-signer-message-${devisId}`),
      ).toContainText(message);
      // The CTA is gone — the devis is no longer at approved_for_signing.
      await expect(page.getByTestId(`button-send-to-signer-${devisId}`)).toHaveCount(0);

      // ---- 7. Server-side assertions ---------------------------------------
      // Archisign mock got exactly one /create (with the architect's message
      // as the email body and the client as signer) and one /send.
      expect(mock.createCalls).toHaveLength(1);
      const wire = mock.createCalls[0].body;
      expect(wire.externalRef).toBe(`devis-${devisId}`);
      expect(wire.body).toBe(message);
      expect(wire.signerEmail).toBe(seeded.clientEmail);
      expect(wire.signerName).toBe("Claire Client");
      expect(mock.sendPaths).toEqual([`/api/v1/envelopes/${MOCK_ENVELOPE_ID}/send`]);

      // Devis row: stage advanced + envelope + message persisted.
      const devisRow = await db.query(
        `SELECT sign_off_stage, archisign_envelope_id, archisign_signer_message,
                archisign_envelope_status
           FROM devis WHERE id = $1`,
        [devisId],
      );
      expect(devisRow.rows[0].sign_off_stage).toBe("sent_to_client");
      expect(devisRow.rows[0].archisign_envelope_id).toBe(String(MOCK_ENVELOPE_ID));
      expect(devisRow.rows[0].archisign_signer_message).toBe(message);
      expect(devisRow.rows[0].archisign_envelope_status).toBe("sent");

      // Context email row: logged + sent through the fake Gmail.
      const comm = await db.query(
        `SELECT type, status, recipient_email
           FROM project_communications
          WHERE project_id = $1 AND type = 'devis_signature_context'`,
        [seeded.projectId],
      );
      expect(comm.rows).toHaveLength(1);
      expect(comm.rows[0].status).toBe("sent");
      expect(comm.rows[0].recipient_email).toBe(seeded.clientEmail);
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
