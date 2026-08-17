import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the client payment suggestion review flow (task #476).
 *
 * Suggestion rows are only created server-side by the Gmail scan, so this
 * spec seeds `certificat_payment_suggestions` directly via SQL (same pattern
 * as the other inbound-email specs), then drives the UI:
 *
 *   1. Certificat detail — PaymentSuggestionCard renders the excerpt; the
 *      amount is edited before confirming; confirming writes a ledger row
 *      (source `email`), flips the "Soldé" badge when TTC is covered, and
 *      the card disappears.
 *   2. Double-record guard — a second confirm attempt on the same suggestion
 *      returns 409 SUGGESTION_ALREADY_REVIEWED and no extra ledger row.
 *   3. Dismiss — the card disappears, no payment is recorded, DB status
 *      becomes `dismissed`.
 *   4. Communications hub — PaymentSuggestionsPanel lists the open
 *      suggestion; if it got reviewed elsewhere in the meantime, clicking
 *      "Confirmer" surfaces the already-reviewed error toast.
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true so that
 * POST /api/auth/dev-login is registered, plus DATABASE_URL.
 */

interface SeededCert {
  id: number;
  certificateRef: string;
  // Server-authoritative: the server recomputes TTC from its own TVA rules,
  // so never assume the value posted at creation time.
  netToPayTtc: string;
}

interface Seed {
  projectId: number;
  contractorId: number;
  confirmCert: SeededCert;
  dismissCert: SeededCert;
  hubCert: SeededCert;
  flipCert: SeededCert;
  confirmSugId: number;
  dismissSugId: number;
  hubSugId: number;
  flipSugId: number;
}

async function closeDialog(page: import("@playwright/test").Page) {
  // Escape can be swallowed by toast focus; use the dialog close button and
  // wait for the overlay to actually go away.
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

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
  expect(
    res.ok(),
    `${url} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`,
  ).toBe(true);
  return (await res.json()) as T;
}

async function createSentCertificat(
  api: APIRequestContext,
  projectId: number,
  contractorId: number,
): Promise<SeededCert> {
  const cert = await postOk<SeededCert>(api, `/api/projects/${projectId}/certificats`, {
    contractorId,
    totalWorksHt: "1000.00",
    pvMvAdjustment: "0.00",
    previousPayments: "0.00",
    retenueGarantie: "0.00",
    netToPayHt: "1000.00",
    tvaAmount: "200.00",
    netToPayTtc: "1200.00",
    status: "draft",
  });
  // Suggestions are only actionable on non-draft certificats.
  const res = await api.patch(`/api/certificats/${cert.id}`, { data: { status: "sent" } });
  expect(res.ok(), `PATCH status sent failed: ${res.status()}`).toBe(true);
  return cert;
}

async function insertSuggestion(
  db: Client,
  opts: {
    certificatId: number;
    projectId: number;
    uniq: string;
    tag: string;
    excerpt: string;
    amount: string;
  },
): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO certificat_payment_suggestions
       (certificat_id, project_id, communication_id, email_message_id, email_thread_id,
        sender_email, email_date, matched_excerpt, suggested_amount, suggested_date, status)
     VALUES ($1, $2, 999999, $3, $4, $5, NOW(), $6, $7, CURRENT_DATE, 'pending_review')
     RETURNING id`,
    [
      opts.certificatId,
      opts.projectId,
      `e2e-sug-${opts.tag}-${opts.uniq}@mail.test`,
      `e2e-thread-${opts.tag}-${opts.uniq}`,
      "client@exemple.fr",
      opts.excerpt,
      opts.amount,
    ],
  );
  return rows[0].id as number;
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const certIds = [s.confirmCert.id, s.dismissCert.id, s.hubCert.id, s.flipCert.id];
  const stmts: Array<[string, unknown[]]> = [
    // suggestions + payments cascade on certificat delete, but be explicit
    ["DELETE FROM certificat_payment_suggestions WHERE certificat_id = ANY($1::int[])", [certIds]],
    ["DELETE FROM certificat_payment_audits WHERE certificat_id = ANY($1::int[])", [certIds]],
    ["DELETE FROM certificat_payments WHERE certificat_id = ANY($1::int[])", [certIds]],
    ["DELETE FROM certificats WHERE id = ANY($1::int[])", [certIds]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[payment-suggestion cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Client payment suggestions — confirm/dismiss (task #476)", () => {
  test("confirm updates the ledger, blocks double-record; dismiss and hub panel work", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-pay-sug-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      const api = context.request;

      const project = await postOk<{ id: number }>(api, "/api/projects", {
        name: `PaySug ${uniq}`,
        code: `PS-${uniq}`,
        clientName: "Pay Sug Client",
      });
      const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
        name: `PaySug Co ${uniq}`,
      });
      const confirmCert = await createSentCertificat(api, project.id, contractor.id);
      const dismissCert = await createSentCertificat(api, project.id, contractor.id);
      const hubCert = await createSentCertificat(api, project.id, contractor.id);
      const flipCert = await createSentCertificat(api, project.id, contractor.id);

      const confirmSugId = await insertSuggestion(db, {
        certificatId: confirmCert.id,
        projectId: project.id,
        uniq,
        tag: "confirm",
        excerpt: "virement de 500 € effectué ce matin",
        amount: "500.00",
      });
      const dismissSugId = await insertSuggestion(db, {
        certificatId: dismissCert.id,
        projectId: project.id,
        uniq,
        tag: "dismiss",
        excerpt: "nous allons payer bientôt",
        amount: "300.00",
      });
      const hubSugId = await insertSuggestion(db, {
        certificatId: hubCert.id,
        projectId: project.id,
        uniq,
        tag: "hub",
        excerpt: "paiement envoyé hier",
        amount: "250.00",
      });
      // Task #590 — full-TTC suggestion so a one-click hub confirm flips the
      // certificat to "paid" (server recomputes TTC; use its value).
      const flipSugId = await insertSuggestion(db, {
        certificatId: flipCert.id,
        projectId: project.id,
        uniq,
        tag: "flip",
        excerpt: "virement du montant total effectué",
        amount: flipCert.netToPayTtc,
      });
      s = {
        projectId: project.id,
        contractorId: contractor.id,
        confirmCert,
        dismissCert,
        hubCert,
        flipCert,
        confirmSugId,
        dismissSugId,
        hubSugId,
        flipSugId,
      };

      const page = await context.newPage();

      // ------------------------------------------------------------------
      // Phase 1 — confirm with an edited amount from the certificat detail.
      // ------------------------------------------------------------------
      await page.goto("/certificats");
      await page.getByTestId("select-project-filter").click();
      await page.getByRole("option", { name: new RegExp(`PS-${uniq}`) }).click();
      await expect(page.getByTestId(`card-certificat-${confirmCert.id}`)).toBeVisible();

      await page.getByTestId(`button-view-cert-${confirmCert.id}`).click();
      const card = page.getByTestId(`card-payment-suggestion-${confirmSugId}`);
      await expect(card).toBeVisible();
      await expect(page.getByTestId(`text-suggestion-excerpt-${confirmSugId}`)).toHaveText(
        "virement de 500 € effectué ce matin",
      );

      // Edit the suggested amount (500 → the full server-computed TTC) so
      // the certificat becomes exactly soldé, not overpaid.
      const fullTtc = parseFloat(confirmCert.netToPayTtc);
      const amountInput = page.getByTestId(`input-suggestion-amount-${confirmSugId}`);
      await expect(amountInput).toHaveValue("500.00");
      await amountInput.fill(confirmCert.netToPayTtc);
      await page.getByTestId(`button-confirm-suggestion-${confirmSugId}`).click();

      // Card disappears, "Soldé" badge shows, ledger row rendered.
      await expect(card).toHaveCount(0);
      await expect(page.getByTestId("badge-cert-fully-paid")).toBeVisible();
      await expect(page.getByTestId("text-cert-paid-to-date")).toBeVisible();

      // Ledger row exists with the edited amount and source e-mail.
      const ledgerRes = await api.get(`/api/certificats/${confirmCert.id}/payments`);
      expect(ledgerRes.ok()).toBe(true);
      const ledger = (await ledgerRes.json()) as {
        payments: Array<{ id: number; amount: string; source: string }>;
        fullyPaid: boolean;
      };
      expect(ledger.payments.length).toBe(1);
      expect(ledger.payments[0].source).toBe("email");
      expect(parseFloat(ledger.payments[0].amount)).toBeCloseTo(fullTtc, 2);
      expect(ledger.fullyPaid).toBe(true);
      await expect(page.getByTestId(`row-payment-${ledger.payments[0].id}`)).toBeVisible();

      // ------------------------------------------------------------------
      // Phase 2 — a second confirm attempt must be rejected (no double-record).
      // ------------------------------------------------------------------
      const again = await api.post(`/api/certificat-payment-suggestions/${confirmSugId}/confirm`, {
        data: {},
      });
      expect(again.status()).toBe(409);
      const againBody = (await again.json()) as { code?: string };
      expect(againBody.code).toBe("SUGGESTION_ALREADY_REVIEWED");
      const recheck = await api.get(`/api/certificats/${confirmCert.id}/payments`);
      const recheckLedger = (await recheck.json()) as { payments: unknown[] };
      expect(recheckLedger.payments.length).toBe(1);

      await closeDialog(page);

      // ------------------------------------------------------------------
      // Phase 3 — dismiss from the certificat detail.
      // ------------------------------------------------------------------
      await page.getByTestId(`button-view-cert-${dismissCert.id}`).click();
      const dismissCard = page.getByTestId(`card-payment-suggestion-${dismissSugId}`);
      await expect(dismissCard).toBeVisible();
      await page.getByTestId(`button-dismiss-suggestion-${dismissSugId}`).click();
      await expect(dismissCard).toHaveCount(0);
      await expect(page.getByTestId("text-no-payments")).toBeVisible();

      const { rows: dismissedRows } = await db.query(
        "SELECT status FROM certificat_payment_suggestions WHERE id = $1",
        [dismissSugId],
      );
      expect(dismissedRows[0].status).toBe("dismissed");

      await closeDialog(page);

      // ------------------------------------------------------------------
      // Phase 4 — communications hub panel renders open suggestions; a
      // confirm on an already-reviewed row surfaces the error toast.
      // ------------------------------------------------------------------
      await page.goto("/communications");
      await expect(page.getByTestId("panel-payment-suggestions")).toBeVisible();
      const hubRow = page.getByTestId(`row-hub-suggestion-${hubSugId}`);
      await expect(hubRow).toBeVisible();
      await expect(hubRow).toContainText(hubCert.certificateRef);
      // Reviewed suggestions never show in the hub.
      await expect(page.getByTestId(`row-hub-suggestion-${confirmSugId}`)).toHaveCount(0);
      await expect(page.getByTestId(`row-hub-suggestion-${dismissSugId}`)).toHaveCount(0);

      // Simulate a concurrent reviewer flipping the row before the click.
      await db.query(
        "UPDATE certificat_payment_suggestions SET status = 'dismissed', reviewed_by = 'someone-else', reviewed_at = NOW() WHERE id = $1",
        [hubSugId],
      );
      await page.getByTestId(`button-hub-confirm-${hubSugId}`).click();
      await expect(page.getByText("Cette suggestion a déjà été traitée.", { exact: true })).toBeVisible();

      // No ledger row was created for the hub certificat.
      const hubLedger = await api.get(`/api/certificats/${hubCert.id}/payments`);
      const hubLedgerBody = (await hubLedger.json()) as { payments: unknown[] };
      expect(hubLedgerBody.payments.length).toBe(0);

      // ------------------------------------------------------------------
      // Phase 5 (task #590) — a hub one-click confirm must propagate the
      // paid status to the certificats page WITHOUT a page reload. Queries
      // cache forever (staleTime Infinity), so this exercises the shared
      // cache invalidation: populate the certificats-page cache (badge
      // SENT), navigate back to the hub via the sidebar (client-side, cache
      // kept), confirm, then return to certificats and expect PAID.
      // ------------------------------------------------------------------
      const selectFlipProject = async () => {
        await page.getByTestId("select-project-filter").click();
        await page.getByRole("option", { name: new RegExp(`PS-${uniq}`) }).click();
      };
      await page.getByTestId("link-nav-certificats").click();
      await selectFlipProject();
      const flipCard = page.getByTestId(`card-certificat-${flipCert.id}`);
      await expect(flipCard).toBeVisible();
      await expect(flipCard).toContainText("SENT");

      await page.getByTestId("link-nav-communications").click();
      await page.getByTestId(`button-hub-confirm-${flipSugId}`).click();
      await expect(page.getByTestId(`row-hub-suggestion-${flipSugId}`)).toHaveCount(0);

      await page.getByTestId("link-nav-certificats").click();
      await selectFlipProject();
      await expect(flipCard).toBeVisible();
      await expect(flipCard).toContainText("PAID");
      await expect(flipCard).not.toContainText("SENT");
    } finally {
      try {
        await cleanup(db, s);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
