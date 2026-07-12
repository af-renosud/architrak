import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for Task #261 — the devis-signature context email outcome
 * surfaced in the communications log.
 *
 * Verifies, on the Communication Hub page (/communications):
 *   1. A failed `devis_signature_context` row renders with a FAILED badge
 *      and the "Devis Signature Context" type label.
 *   2. The row exposes the inline resend button (gated on the current
 *      envelope via GET /api/devis/:id/context-email-status).
 *   3. Clicking resend re-dispatches the email (fake Gmail in dev), shows a
 *      success toast, refreshes the list (row flips to SENT), and the
 *      resend button disappears (canResend is now false).
 *
 * And on the project-detail Communications tab:
 *   4. The same failed row shows the resend button instead of the generic
 *      "Send" button.
 *
 * Seeding: project + contractor + devis via the API, then the Archisign
 * envelope fields and the failed communication row via direct SQL (there is
 * no public API that produces a failed context email deterministically).
 *
 * Requires NODE_ENV=development, ENABLE_DEV_LOGIN_FOR_E2E=true,
 * E2E_FAKE_GMAIL=true and DATABASE_URL.
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
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

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

test.describe("Communications log — devis context email outcome (task #261)", () => {
  test("failed context email row shows badge + resend, resend flips it to sent", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-ctx-comms-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let projectId: number | null = null;
    let contractorId: number | null = null;
    let devisId: number | null = null;
    let commId: number | null = null;

    try {
      await devLogin(context.request, email);

      const project = await postOk<{ id: number }>(context.request, "/api/projects", {
        name: `CtxComms ${uniq}`,
        code: `CTX-${uniq}`,
        clientName: "Ctx Client",
        clientContactName: "Ctx Contact",
        clientContactEmail: `client-${uniq}@local.test`,
      });
      projectId = project.id;
      const contractor = await postOk<{ id: number }>(context.request, "/api/contractors", {
        name: `Ctx Co ${uniq}`,
      });
      contractorId = contractor.id;
      const devis = await postOk<{ id: number }>(
        context.request,
        `/api/projects/${projectId}/devis`,
        {
          contractorId,
          devisCode: `CTX-D-${uniq}`,
          descriptionFr: `Context email ${uniq}`,
          amountHt: "100.00",
          amountTtc: "120.00",
          invoicingMode: "mode_b",
        },
      );
      devisId = devis.id;

      // Persist an active envelope + signer message (normally written by the
      // send-to-signer flow; no public API sets these directly).
      const envelopeId = `env-e2e-${uniq}`;
      await db.query(
        "UPDATE devis SET archisign_envelope_id = $1, archisign_signer_message = $2 WHERE id = $3",
        [envelopeId, "Hello, here is the devis to sign — e2e context message.", devisId],
      );

      // Insert the FAILED context-email communication row the original
      // dispatch would have left behind.
      const inserted = await db.query(
        `INSERT INTO project_communications
           (project_id, type, recipient_type, recipient_email, recipient_name, subject, body, status, dedupe_key)
         VALUES ($1, 'devis_signature_context', 'client', $2, 'Ctx Contact', $3, 'Corps e2e', 'failed', $4)
         RETURNING id`,
        [
          projectId,
          `client-${uniq}@local.test`,
          `Devis CTX-D-${uniq} — signature électronique à venir`,
          `devis-signature-context:${devisId}:${envelopeId}`,
        ],
      );
      commId = inserted.rows[0].id as number;

      // ---------- Communication Hub page ----------
      const page = await context.newPage();
      await page.goto("/communications");

      const card = page.getByTestId(`card-comm-${commId}`);
      await expect(card).toBeVisible();
      // FAILED badge + type label
      await expect(card.getByTestId("status-badge-failed")).toBeVisible();
      await expect(card.getByText("Devis Signature Context")).toBeVisible();

      // Resend button is exposed (status endpoint says canResend for the
      // current envelope).
      const resendBtn = page.getByTestId(`button-resend-context-email-comm-${commId}`);
      await expect(resendBtn).toBeVisible();

      // ---------- Project-detail Communications tab ----------
      const projPage = await context.newPage();
      await projPage.goto(`/projets/${projectId}`);
      await projPage.getByTestId("tab-communications").click();
      const projCard = projPage.getByTestId(`card-comm-${commId}`);
      await expect(projCard).toBeVisible();
      await expect(projCard.getByTestId("status-badge-failed")).toBeVisible();
      await expect(
        projPage.getByTestId(`button-resend-context-email-comm-${commId}`),
      ).toBeVisible();
      // The generic queued/draft "Send" button must NOT render for this type.
      await expect(projPage.getByTestId(`button-send-comm-${commId}`)).toHaveCount(0);
      await projPage.close();

      // ---------- Resend from the hub ----------
      await resendBtn.click();
      // Success toast (fake Gmail in dev makes the send succeed). `.first()`
      // because the toast text also appears in the aria-live announcer.
      await expect(page.getByText("Context email sent").first()).toBeVisible();
      // List refreshes: the same row flips to SENT and the button disappears.
      await expect(card.getByTestId("status-badge-sent")).toBeVisible();
      await expect(
        page.getByTestId(`button-resend-context-email-comm-${commId}`),
      ).toHaveCount(0);
    } finally {
      try {
        if (commId) await db.query("DELETE FROM project_communications WHERE id = $1", [commId]);
        if (devisId) {
          await db.query("DELETE FROM devis_line_items WHERE devis_id = $1", [devisId]);
          await db.query("DELETE FROM devis WHERE id = $1", [devisId]);
        }
        if (projectId) {
          await db.query("DELETE FROM project_communications WHERE project_id = $1", [projectId]);
          await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
        }
        if (contractorId) await db.query("DELETE FROM contractors WHERE id = $1", [contractorId]);
      } catch (err) {
        console.warn("[ctx-comms cleanup] swallowed:", (err as Error).message);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
