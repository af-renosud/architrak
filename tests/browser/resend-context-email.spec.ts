import { test, expect, type Browser, type BrowserContext, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * E2E coverage for the "Resend context email" recovery button
 * (task #258) inside the SigningPanel:
 *
 *   devis in sent_to_client with an envelope + persisted signer message
 *   and a FAILED `devis_signature_context` communication row
 *     → warning line + resend button render
 *     → click → POST /resend-context-email → fake Gmail send succeeds
 *     → success toast "Context email sent"
 *     → the status query is invalidated, refetches canResend=false,
 *       and the warning + button disappear
 *     → DB: the SAME communication row (retried in place via dedupeKey)
 *       is now status='sent'
 *
 *   a second devis whose communication row is already 'sent'
 *     → the warning + button never render (signer message still shows).
 *
 * The resend path only touches the DB and the fake Gmail client — no
 * Archisign traffic — so no mock Archisign server is needed; the envelope
 * fields are seeded directly. The spec boots ITS OWN app instance on a
 * dedicated port (the shared :5000 dev server does not set
 * ENABLE_DEV_LOGIN_FOR_E2E) with E2E_FAKE_GMAIL=true so the send is
 * captured by the in-memory fake and reports "sent".
 *
 * Requires DATABASE_URL (seeding envelope fields / communication rows has
 * no public API) and the usual dev deps (tsx).
 */

const APP_PORT = 5139;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

const ENVELOPE_A = "911001";
const ENVELOPE_B = "911002";
const SIGNER_MESSAGE_A =
  "Dear Claire, here is the devis context ahead of the signature request. Kind regards.";
const SIGNER_MESSAGE_B =
  "Bonjour Claire, second devis prêt pour signature électronique. Cordialement.";

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
  projectId: number;
  contractorId: number;
  devisAId: number; // failed context email → resend expected
  devisBId: number; // context email already sent → no button
  failedCommId: number;
  sentCommId: number;
  clientEmail: string;
}

function dedupeKey(devisId: number, envelopeId: string): string {
  return `devis-signature-context:${devisId}:${envelopeId}`;
}

async function seed(api: APIRequestContext, db: Client, uniq: string): Promise<Seed> {
  const email = `e2e-resend-ctx-${uniq}@local.test`;
  await postOk<{ id: number }>(api, "/api/auth/dev-login", { email });

  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `Resend Context ${uniq}`,
    code: `RC-${uniq}`,
    clientName: "Resend Client SARL",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `RC Contractor ${uniq}`,
  });

  async function createDevis(tag: string): Promise<number> {
    const d = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
      contractorId: contractor.id,
      devisCode: `RC-DEV-${tag}-${uniq}`,
      descriptionFr: `Travaux resend contexte ${tag}`,
      descriptionUk: `Resend context works ${tag}`,
      amountHt: "1000.00",
      amountTtc: "1200.00",
      invoicingMode: "mode_b",
    });
    return d.id;
  }
  const devisAId = await createDevis("A");
  const devisBId = await createDevis("B");

  const clientEmail = `resend-client-${uniq}@example.test`;
  // No public API for these rows/transitions — seed directly:
  //   - client contact (the resend recipient; the email dispatch throws
  //     without it)
  //   - sent_to_client stage + envelope fields + persisted signer message
  //     (the SigningPanel envelope-details section and the status query's
  //     enabled gate both require envelopeId + message)
  //   - the `devis_signature_context` communication rows keyed by the SAME
  //     dedupeKey the original dispatch used.
  await db.query(
    `UPDATE projects SET client_contact_name = $1, client_contact_email = $2 WHERE id = $3`,
    ["Claire Client", clientEmail, project.id],
  );
  await db.query(
    `UPDATE devis
        SET sign_off_stage = 'sent_to_client',
            archisign_envelope_id = $1,
            archisign_envelope_status = 'sent',
            archisign_signer_message = $2
      WHERE id = $3`,
    [ENVELOPE_A, SIGNER_MESSAGE_A, devisAId],
  );
  await db.query(
    `UPDATE devis
        SET sign_off_stage = 'sent_to_client',
            archisign_envelope_id = $1,
            archisign_envelope_status = 'sent',
            archisign_signer_message = $2
      WHERE id = $3`,
    [ENVELOPE_B, SIGNER_MESSAGE_B, devisBId],
  );

  const failedComm = await db.query(
    `INSERT INTO project_communications
       (project_id, type, recipient_type, recipient_email, recipient_name,
        subject, body, status, dedupe_key)
     VALUES ($1, 'devis_signature_context', 'client', $2, 'Claire Client',
             $3, $4, 'failed', $5)
     RETURNING id`,
    [
      project.id,
      clientEmail,
      `Devis RC-DEV-A-${uniq} — Resend Context ${uniq} : signature électronique à venir`,
      SIGNER_MESSAGE_A,
      dedupeKey(devisAId, ENVELOPE_A),
    ],
  );
  const sentComm = await db.query(
    `INSERT INTO project_communications
       (project_id, type, recipient_type, recipient_email, recipient_name,
        subject, body, status, sent_at, dedupe_key)
     VALUES ($1, 'devis_signature_context', 'client', $2, 'Claire Client',
             $3, $4, 'sent', NOW(), $5)
     RETURNING id`,
    [
      project.id,
      clientEmail,
      `Devis RC-DEV-B-${uniq} — Resend Context ${uniq} : signature électronique à venir`,
      SIGNER_MESSAGE_B,
      dedupeKey(devisBId, ENVELOPE_B),
    ],
  );

  return {
    projectId: project.id,
    contractorId: contractor.id,
    devisAId,
    devisBId,
    failedCommId: failedComm.rows[0].id as number,
    sentCommId: sentComm.rows[0].id as number,
    clientEmail,
  };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM project_communications WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM devis_line_items WHERE devis_id IN ($1, $2)", [s.devisAId, s.devisBId]],
    ["DELETE FROM devis WHERE id IN ($1, $2)", [s.devisAId, s.devisBId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[resend-context cleanup] swallowed:", (err as Error).message);
    }
  }
}

async function expandDevisRow(page: Page, devisId: number) {
  await page.getByTestId(`row-devis-toggle-${devisId}`).click();
  await expect(page.getByTestId(`panel-signing-${devisId}`)).toBeVisible();
  // The envelope-details block (with the signer message) confirms the
  // seeded envelope fields made it to the panel.
  await expect(page.getByTestId(`text-archisign-signer-message-${devisId}`)).toBeVisible();
}

test.describe("Resend context email button — SigningPanel recovery flow (task #258)", () => {
  test("failed row shows warning + button; click resends via fake Gmail and hides the button; sent row never shows it", async ({
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

    let app: Awaited<ReturnType<typeof startAppServer>> | null = null;
    let context: BrowserContext | null = null;
    let seeded: Seed | null = null;

    try {
      app = await startAppServer();
      context = await browser.newContext({
        baseURL: APP_URL,
        viewport: { width: 1600, height: 1000 },
      });
      seeded = await seed(context.request, db, uniq);
      const { devisAId, devisBId } = seeded;

      const page = await context.newPage();
      await page.goto(`/projets/${seeded.projectId}`);
      await page.getByTestId("tab-devis").click();

      // ---- 1. Devis A (failed row): warning + button render ---------------
      await expandDevisRow(page, devisAId);
      const warning = page.getByTestId(`text-context-email-missing-${devisAId}`);
      const resendBtn = page.getByTestId(`button-resend-context-email-${devisAId}`);
      await expect(warning).toBeVisible();
      await expect(warning).toContainText(
        "The accompanying email was not sent to the client.",
      );
      await expect(resendBtn).toBeVisible();
      await expect(resendBtn).toContainText("Resend context email");

      // ---- 2. Click → resend through the fake Gmail → success toast -------
      await resendBtn.click();
      await expect(page.getByText("Context email sent", { exact: true })).toBeVisible();
      // The success toast is the fresh-send one, not the already_sent variant.
      await expect(page.getByText("Context email already sent")).toHaveCount(0);
      await expect(page.getByText("Failed to resend the context email")).toHaveCount(0);

      // ---- 3. Status query refetches → warning + button disappear ---------
      await expect(warning).toHaveCount(0);
      await expect(resendBtn).toHaveCount(0);
      // The signer message block itself stays.
      await expect(
        page.getByTestId(`text-archisign-signer-message-${devisAId}`),
      ).toContainText(SIGNER_MESSAGE_A);

      // ---- 4. DB: the SAME row was retried in place (dedupeKey) -----------
      const commA = await db.query(
        `SELECT id, status, sent_at, recipient_email
           FROM project_communications
          WHERE dedupe_key = $1`,
        [dedupeKey(devisAId, ENVELOPE_A)],
      );
      expect(commA.rows).toHaveLength(1);
      expect(commA.rows[0].id).toBe(seeded.failedCommId);
      expect(commA.rows[0].status).toBe("sent");
      expect(commA.rows[0].sent_at).not.toBeNull();
      expect(commA.rows[0].recipient_email).toBe(seeded.clientEmail);
      // No duplicate context-email row was created for devis A.
      const allA = await db.query(
        `SELECT COUNT(*)::int AS n FROM project_communications
          WHERE project_id = $1 AND type = 'devis_signature_context'`,
        [seeded.projectId],
      );
      expect(allA.rows[0].n).toBe(2); // devis A row + devis B row, nothing new

      // ---- 5. Devis B (already sent): button never renders -----------------
      await expandDevisRow(page, devisBId);
      await expect(
        page.getByTestId(`text-archisign-signer-message-${devisBId}`),
      ).toContainText(SIGNER_MESSAGE_B);
      // Give the status query a moment to settle before asserting absence:
      // wait for the response of the status endpoint for devis B.
      await page.waitForResponse(
        (res) =>
          res.url().includes(`/api/devis/${devisBId}/context-email-status`) &&
          res.status() === 200,
        { timeout: 15_000 },
      ).catch(() => {
        /* Already fetched before we started waiting — the assertions below
           still hold because canResend=false renders nothing. */
      });
      await expect(page.getByTestId(`text-context-email-missing-${devisBId}`)).toHaveCount(0);
      await expect(page.getByTestId(`button-resend-context-email-${devisBId}`)).toHaveCount(0);

      // DB: devis B's row untouched.
      const commB = await db.query(
        `SELECT id, status FROM project_communications WHERE dedupe_key = $1`,
        [dedupeKey(devisBId, ENVELOPE_B)],
      );
      expect(commB.rows).toHaveLength(1);
      expect(commB.rows[0].id).toBe(seeded.sentCommId);
      expect(commB.rows[0].status).toBe("sent");
    } finally {
      try {
        await cleanup(db, seeded);
      } finally {
        await db.end();
        if (context) await context.close();
        if (app) await app.stop();
      }
    }
  });
});
