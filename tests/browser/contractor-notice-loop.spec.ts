import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the contractor payment-notice loop (task #520).
 *
 * Task #519 added a contractor payment-notice email queued alongside every
 * certificat client send, and a Gmail reply scanner that turns contractor
 * "paiement bien reçu" replies into `contractor_received` suggestions.
 *
 * This spec covers the full visible flow:
 *
 *   1. Queued contractor notice — a `certificat_contractor_notice` comm
 *      seeded with status='queued' appears on the communications page (type
 *      filter "Contractor Payment Notice", status filter "Queued").
 *   2. Contractor suggestion renders — a `contractor_received` suggestion
 *      (seeded directly via SQL, same pattern as the client-paid spec) shows
 *      as "Réception confirmée par l'entreprise" on the certificat detail;
 *      an open `client_paid` counterpart is also visible.
 *   3. Confirm records the ledger — confirming the contractor_received
 *      suggestion writes a source='email' ledger entry, flips the "Soldé"
 *      badge, and the card disappears.
 *   4. Auto-dismiss of counterpart — the open client_paid suggestion for the
 *      same certificat is automatically dismissed in the same transaction;
 *      its DB status is 'dismissed', and it no longer appears in the hub.
 *   5. Hub is clean — neither suggestion row appears in the communications
 *      hub panel after confirmation.
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true, plus
 * DATABASE_URL.
 */

interface SeededCert {
  id: number;
  certificateRef: string;
  netToPayTtc: string;
}

interface Seed {
  projectId: number;
  contractorId: number;
  loopCert: SeededCert;
  loopContractorSugId: number;
  loopClientSugId: number;
  commId: number;
}

async function closeDialog(page: import("@playwright/test").Page) {
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
    kind: "client_paid" | "contractor_received";
    senderEmail: string;
  },
): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO certificat_payment_suggestions
       (certificat_id, project_id, communication_id, email_message_id, email_thread_id,
        sender_email, email_date, matched_excerpt, suggested_amount, suggested_date, status, kind)
     VALUES ($1, $2, 999999, $3, $4, $5, NOW(), $6, $7, CURRENT_DATE, 'pending_review', $8)
     RETURNING id`,
    [
      opts.certificatId,
      opts.projectId,
      `e2e-sug-${opts.tag}-${opts.uniq}@mail.test`,
      `e2e-thread-${opts.tag}-${opts.uniq}`,
      opts.senderEmail,
      opts.excerpt,
      opts.amount,
      opts.kind,
    ],
  );
  return rows[0].id as number;
}

async function insertContractorNoticeComm(
  db: Client,
  opts: {
    projectId: number;
    certId: number;
    uniq: string;
    contractorEmail: string;
  },
): Promise<number> {
  // Seed a queued contractor notice — mirrors what email-sender.ts enqueues
  // alongside the client certificat send. The dedupe_key must be unique so
  // the test row doesn't clash with any real send triggered by the test app.
  const { rows } = await db.query(
    `INSERT INTO project_communications
       (project_id, type, recipient_type, recipient_email, subject, body,
        status, related_certificat_id, dedupe_key)
     VALUES ($1, 'certificat_contractor_notice', 'contractor', $2, $3,
             'Avis de paiement (test).', 'queued', $4, $5)
     RETURNING id`,
    [
      opts.projectId,
      opts.contractorEmail,
      `Avis de paiement — certificat e2e-${opts.uniq}`,
      opts.certId,
      `e2e-contractor-notice-${opts.uniq}`,
    ],
  );
  return rows[0].id as number;
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const certIds = [s.loopCert.id];
  const stmts: Array<[string, unknown[]]> = [
    // Delete the seeded contractor notice comm before the certificat
    // (no cascade on related_certificat_id).
    ["DELETE FROM project_communications WHERE id = $1", [s.commId]],
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
      console.warn("[contractor-notice cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Contractor notice loop — send → reply → confirm (task #520)", () => {
  test("queued notice visible; contractor_received confirms to ledger and auto-dismisses client_paid", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-ctr-notice-${uniq}@local.test`;
    const contractorEmail = `contractor-${uniq}@entreprise.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let s: Seed | null = null;

    try {
      await devLogin(context.request, email);
      const api = context.request;

      const project = await postOk<{ id: number }>(api, "/api/projects", {
        name: `CtrNotice ${uniq}`,
        code: `CN-${uniq}`,
        clientName: "Notice Test Client",
      });
      const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
        name: `CtrNotice Co ${uniq}`,
        email: contractorEmail,
      });
      const loopCert = await createSentCertificat(api, project.id, contractor.id);

      // Seed a queued contractor notice — simulates the comm that
      // email-sender.ts enqueues alongside the client certificat send.
      const commId = await insertContractorNoticeComm(db, {
        projectId: project.id,
        certId: loopCert.id,
        uniq,
        contractorEmail,
      });

      // Use the server-authoritative TTC — the server recomputes it from its
      // own TVA rules, so never assume the posted value was stored verbatim.
      const certTtc = loopCert.netToPayTtc;

      // Seed a contractor_received suggestion — simulates the Gmail reply
      // scanner having detected "paiement bien reçu" from the contractor.
      const loopContractorSugId = await insertSuggestion(db, {
        certificatId: loopCert.id,
        projectId: project.id,
        uniq,
        tag: "ctr",
        excerpt: "paiement bien reçu, merci",
        amount: certTtc,
        kind: "contractor_received",
        senderEmail: contractorEmail,
      });

      // Seed a client_paid suggestion for the same cert — the auto-dismiss
      // logic must wipe this counterpart when contractor_received is confirmed.
      const loopClientSugId = await insertSuggestion(db, {
        certificatId: loopCert.id,
        projectId: project.id,
        uniq,
        tag: "cli",
        excerpt: "virement de 1200 € effectué ce matin",
        amount: certTtc,
        kind: "client_paid",
        senderEmail: "client@exemple.fr",
      });

      s = {
        projectId: project.id,
        contractorId: contractor.id,
        loopCert,
        loopContractorSugId,
        loopClientSugId,
        commId,
      };

      const page = await context.newPage();

      // ------------------------------------------------------------------
      // Phase 1 — queued contractor notice appears in project communications.
      //
      // The comm card is visible on the unfiltered list; additionally verify
      // the "Queued" count stat increments and that the card carries the
      // "Contractor Payment Notice" type badge.
      // ------------------------------------------------------------------
      await page.goto("/communications");
      await expect(page.getByTestId("panel-payment-suggestions")).toBeVisible({ timeout: 10_000 });

      // At least one communication is queued (our seeded contractor notice).
      const queuedCount = page.getByTestId("text-queued-count");
      await expect(queuedCount).not.toHaveText("0", { timeout: 10_000 });

      // The card itself is present with the expected type label.
      const commCard = page.getByTestId(`card-comm-${commId}`);
      await expect(commCard).toBeVisible({ timeout: 10_000 });
      await expect(commCard).toContainText("Contractor Payment Notice");
      await expect(commCard).toContainText("QUEUED");

      // ------------------------------------------------------------------
      // Phase 2 — contractor_received suggestion renders on the certificat
      // detail as "Réception confirmée par l'entreprise", and the open
      // client_paid card is also visible.
      // ------------------------------------------------------------------
      await page.goto("/certificats");
      await page.getByTestId("select-project-filter").click();
      await page.getByRole("option", { name: new RegExp(`CN-${uniq}`) }).click();
      await expect(page.getByTestId(`card-certificat-${loopCert.id}`)).toBeVisible();

      await page.getByTestId(`button-view-cert-${loopCert.id}`).click();

      const ctrCard = page.getByTestId(`card-payment-suggestion-${loopContractorSugId}`);
      await expect(ctrCard).toBeVisible();
      await expect(ctrCard).toContainText("Réception confirmée par l'entreprise");
      await expect(page.getByTestId(`text-suggestion-excerpt-${loopContractorSugId}`)).toHaveText(
        "paiement bien reçu, merci",
      );

      // The client counterpart is also open at this point.
      const cliCard = page.getByTestId(`card-payment-suggestion-${loopClientSugId}`);
      await expect(cliCard).toBeVisible();

      // ------------------------------------------------------------------
      // Phase 3 — confirming the contractor_received suggestion writes a
      // ledger entry with source='email' and flips the "Soldé" badge.
      // ------------------------------------------------------------------
      await page.getByTestId(`button-confirm-suggestion-${loopContractorSugId}`).click();

      // Contractor suggestion card disappears after confirm.
      await expect(ctrCard).toHaveCount(0);
      // Client counterpart auto-dismissed in the same transaction.
      await expect(cliCard).toHaveCount(0);

      await expect(page.getByTestId("badge-cert-fully-paid")).toBeVisible();

      // Ledger: one entry, source='email', amount matches the full TTC.
      const ledgerRes = await api.get(`/api/certificats/${loopCert.id}/payments`);
      expect(ledgerRes.ok()).toBe(true);
      const ledger = (await ledgerRes.json()) as {
        payments: Array<{ id: number; amount: string; source: string }>;
        fullyPaid: boolean;
      };
      expect(ledger.payments.length).toBe(1);
      expect(ledger.payments[0].source).toBe("email");
      expect(parseFloat(ledger.payments[0].amount)).toBeCloseTo(parseFloat(certTtc), 2);
      expect(ledger.fullyPaid).toBe(true);
      await expect(page.getByTestId(`row-payment-${ledger.payments[0].id}`)).toBeVisible();

      // DB: contractor suggestion confirmed, client counterpart auto-dismissed.
      const { rows: sugRows } = await db.query(
        "SELECT id, kind, status FROM certificat_payment_suggestions WHERE id = ANY($1::int[]) ORDER BY id",
        [[loopContractorSugId, loopClientSugId]],
      );
      const byId = Object.fromEntries(
        sugRows.map((r: { id: number; kind: string; status: string }) => [r.id, r]),
      );
      expect(byId[loopContractorSugId].status).toBe("confirmed");
      expect(byId[loopClientSugId].status).toBe("dismissed");

      await closeDialog(page);

      // ------------------------------------------------------------------
      // Phase 4 — hub panel shows neither suggestion after confirmation.
      //
      // The panel renders null when rows.length === 0, so it may not be
      // present at all — that is itself evidence both suggestions are gone.
      // We just assert the individual row locators are absent.
      // ------------------------------------------------------------------
      await page.goto("/communications");
      // Wait for the page to settle before checking absence.
      await expect(page.getByTestId("text-total-comms")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId(`row-hub-suggestion-${loopContractorSugId}`)).toHaveCount(0);
      await expect(page.getByTestId(`row-hub-suggestion-${loopClientSugId}`)).toHaveCount(0);
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
