import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the certificat "Sent" status flip after clicking Send
 * (task #555 — verifying task #554 wiring).
 *
 * Verifies:
 *   1. After clicking the Send button on the project Communications tab, the
 *      /certificats page shows "SENT" badge on the cert card.
 *   2. The project Certificats tab also shows "SENT" badge.
 *   3. The devis CertificatPanel shows "Sent" badge.
 *   4. The Send button on the Communications tab disappears (cert no longer ready).
 *   5. The Send button on the devis panel disappears.
 *
 * Uses E2E_FAKE_GMAIL=true (set in the dev workflow) so no real email is sent.
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true plus
 * DATABASE_URL for seeding and cleanup.
 */

async function postOk<T = unknown>(
  api: APIRequestContext,
  url: string,
  body: unknown,
): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(
    res.ok(),
    `${url} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`,
  ).toBe(true);
  return (await res.json()) as T;
}

interface Seed {
  projectId: number;
  contractorId: number;
  devisId: number;
  certId: number;
  lotId: number;
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM project_communications WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM certificats WHERE id = $1", [s.certId]],
    ["DELETE FROM devis_translations WHERE devis_id = $1", [s.devisId]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM lots WHERE id = $1", [s.lotId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[cert-sent-status cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Certificat — status flips to Sent end-to-end (task #555)", () => {
  test(
    "clicking Send flips badge to Sent on /certificats, project tab, and devis panel",
    async ({ browser }) => {
      const databaseUrl = process.env.DATABASE_URL;
      expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

      const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const email = `e2e-cert-sent-${uniq}@local.test`;
      const db = new Client({ connectionString: databaseUrl! });
      await db.connect();

      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      let s: Seed | null = null;

      try {
        const api = context.request;
        const login = await api.post("/api/auth/dev-login", { data: { email } });
        expect(login.ok(), `dev-login failed (${login.status()})`).toBe(true);

        // ── Seed ────────────────────────────────────────────────────────────
        const project = await postOk<{ id: number }>(api, "/api/projects", {
          name: `CertSent ${uniq}`,
          code: `CS-${uniq}`,
          clientName: "Cert Sent Client",
          clientContactEmail: `client-${uniq}@example.com`,
        });
        const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
          name: `CertSent Co ${uniq}`,
          iban: "FR7630006000011234567890189",
          bic: "BNPAFRPP",
        });
        const lot = await postOk<{ id: number }>(api, `/api/projects/${project.id}/lots`, {
          lotNumber: "01",
          descriptionFr: "Gros oeuvre",
          descriptionUk: "Structural works",
        });
        const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
          contractorId: contractor.id,
          devisCode: `CS-DEV-${uniq}`,
          descriptionFr: "Travaux de structure",
          descriptionUk: "Structural works",
          amountHt: "5000.00",
          amountTtc: "6000.00",
          invoicingMode: "mode_b",
          lotId: lot.id,
        });
        // Advance devis to client_signed_off so the CertificatPanel renders.
        await db.query(
          `UPDATE devis SET sign_off_stage = 'client_signed_off' WHERE id = $1`,
          [devis.id],
        );

        const cert = await postOk<{ id: number; certificateRef: string }>(
          api,
          `/api/projects/${project.id}/certificats`,
          {
            contractorId: contractor.id,
            totalWorksHt: "5000.00",
            pvMvAdjustment: "0.00",
            previousPayments: "0.00",
            retenueGarantie: "0.00",
            netToPayHt: "5000.00",
            tvaAmount: "1000.00",
            netToPayTtc: "6000.00",
            status: "ready",
          },
        );

        s = {
          projectId: project.id,
          contractorId: contractor.id,
          devisId: devis.id,
          certId: cert.id,
          lotId: lot.id,
        };

        const page = await context.newPage();

        // ── 1. Send via the project Communications tab ──────────────────────
        await page.goto(`/projets/${project.id}`);
        await page.getByTestId("tab-communications").click();

        const sendBtn = page.getByTestId(`button-send-cert-${cert.id}`);
        await expect(sendBtn).toBeVisible();
        await sendBtn.click();

        // Wait for the send to complete: button should disappear (cert no longer ready).
        await expect(sendBtn).not.toBeVisible({ timeout: 10_000 });

        // ── 2. /certificats page — badge shows SENT ─────────────────────────
        await page.goto("/certificats");
        await page.getByTestId("select-project-filter").click();
        await page
          .getByRole("option", { name: new RegExp(`CS-${uniq}`) })
          .click();

        const certCard = page.getByTestId(`card-certificat-${cert.id}`);
        await expect(certCard).toBeVisible();

        // StatusBadge renders data-testid="status-badge-sent" inside the card.
        await expect(certCard.getByTestId("status-badge-sent")).toBeVisible();

        // "Mark Sent" advance button must be gone (cert is past ready).
        // After sending the status is "sent", so next action is "Mark Paid" —
        // the important invariant is that the "Mark Sent" label is absent.
        await expect(
          certCard.getByText("Mark Sent"),
        ).not.toBeVisible();

        // ── 3. Project Certificats tab — badge shows SENT ───────────────────
        await page.goto(`/projets/${project.id}`);
        await page.getByTestId("tab-certificats").click();

        const tabCard = page.getByTestId(`card-certificat-tab-${cert.id}`);
        await expect(tabCard).toBeVisible();
        await expect(tabCard.getByTestId("status-badge-sent")).toBeVisible();

        // "Mark Sent" button must be absent on the project tab too.
        await expect(
          tabCard.getByText("Mark Sent"),
        ).not.toBeVisible();

        // ── 4. Devis CertificatPanel — badge shows Sent ─────────────────────
        await page.getByTestId("tab-devis").click();
        await page.getByTestId(`row-devis-toggle-${devis.id}`).click();

        const panel = page.getByTestId(`panel-certificat-${devis.id}`);
        await expect(panel).toBeVisible();

        const devisCertRow = panel.getByTestId(`row-devis-certificat-${cert.id}`);
        await expect(devisCertRow).toBeVisible();

        // Badge in the devis panel shows "Sent".
        const devisBadge = devisCertRow.getByTestId(`badge-devis-cert-status-${cert.id}`);
        await expect(devisBadge).toBeVisible();
        await expect(devisBadge).toHaveText("Sent");

        // The per-cert Send button in the devis panel must be gone.
        await expect(
          panel.getByTestId(`button-devis-send-cert-${cert.id}`),
        ).not.toBeVisible();
      } finally {
        try {
          await cleanup(db, s);
        } finally {
          await db.end();
          await context.close();
        }
      }
    },
  );
});
