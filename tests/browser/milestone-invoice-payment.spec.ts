import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for task #617 — the milestone invoice/payment chain:
 * detected invoice → invoiced → paid.
 *
 *   1. A pending Gmail-detected fee invoice surfaces on the dashboard alert,
 *      the Honoraires-page badge + review banner, and the project's design
 *      contract card prompt.
 *   2. Confirming from the Honoraires banner binds the invoice to the
 *      milestone (milestone → invoiced).
 *   3. A seeded "client paid" email suggestion renders on the contract card;
 *      confirming it flips the milestone to paid with paidAt = suggested date.
 *   4. A manual "Mark paid" button flips an invoiced milestone to paid.
 *
 * Suggestion + detected-invoice rows are only created server-side by the
 * Gmail scan, so this spec seeds them directly via SQL (same pattern as
 * payment-suggestion-confirm.spec.ts).
 *
 * Requires NODE_ENV=development AND ENABLE_DEV_LOGIN_FOR_E2E=true.
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`).toBe(true);
}

interface Seed {
  projectId: number;
  contractId: number;
  m1: number;
  m2: number;
  invoiceId: number;
  suggestionId: number;
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM milestone_payment_suggestions WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM architect_fee_invoice_events WHERE architect_fee_invoice_id = $1", [s.invoiceId]],
    ["DELETE FROM architect_fee_invoices WHERE id = $1", [s.invoiceId]],
    ["DELETE FROM fee_entries WHERE fee_id IN (SELECT id FROM fees WHERE project_id = $1)", [s.projectId]],
    ["DELETE FROM fees WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM design_contract_milestones WHERE contract_id = $1", [s.contractId]],
    ["DELETE FROM design_contracts WHERE id = $1", [s.contractId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[milestone-invoice cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Milestone invoice/payment chain (task #617)", () => {
  test("detected invoice surfaces, confirm invoices the milestone, suggestion + manual flip to paid", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-ms-pay-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let s: Seed | null = null;

    try {
      const api = context.request;
      await devLogin(api, email);
      const { rows: userRows } = await db.query("SELECT id FROM users WHERE email = $1", [email]);
      const userId = userRows[0].id as number;

      const projRes = await api.post("/api/projects", {
        data: { name: `MsPay ${uniq}`, code: `MP-${uniq}`, clientName: "Ms Pay Client" },
      });
      expect(projRes.ok()).toBe(true);
      const project = (await projRes.json()) as { id: number };

      // Design contract owned by the dev-login user (milestone PATCH is
      // owner-gated) with two milestones: m1 reached (will be invoiced via
      // the detected invoice), m2 invoiced (will be paid via suggestion).
      const { rows: cRows } = await db.query(
        `INSERT INTO design_contracts (project_id, storage_key, original_filename, total_ttc, uploaded_by_user_id)
         VALUES ($1, $2, 'e2e-contract.pdf', '10800.00', $3) RETURNING id`,
        [project.id, `design-contracts/e2e/${uniq}.pdf`, userId],
      );
      const contractId = cRows[0].id as number;
      const { rows: m1Rows } = await db.query(
        `INSERT INTO design_contract_milestones (contract_id, sequence, label_fr, percentage, amount_ttc, trigger_event, status, reached_at)
         VALUES ($1, 1, 'Ouverture de dossier', 16.67, '1800.00', 'file_opened', 'reached', NOW()) RETURNING id`,
        [contractId],
      );
      const m1 = m1Rows[0].id as number;
      const { rows: m2Rows } = await db.query(
        `INSERT INTO design_contract_milestones (contract_id, sequence, label_fr, percentage, amount_ttc, trigger_event, status, reached_at, invoiced_at)
         VALUES ($1, 2, 'Esquisse validée', 33.33, '3600.00', 'concept_signed', 'invoiced', NOW(), NOW()) RETURNING id`,
        [contractId],
      );
      const m2 = m2Rows[0].id as number;

      // Pending Gmail-detected fee invoice whose candidates point at the
      // project + milestone m1.
      const candidates = {
        projects: [{ projectId: project.id, score: 80, reasons: ["client name match"], name: `MsPay ${uniq}`, clientName: "Ms Pay Client" }],
        highConfidenceProjectId: project.id,
        milestones: {
          [String(project.id)]: [
            { milestoneId: m1, score: 60, reasons: ["amount match"], labelFr: "Ouverture de dossier", sequence: 1, amountTtc: "1800.00" },
          ],
        },
      };
      const { rows: invRows } = await db.query(
        `INSERT INTO architect_fee_invoices (invoice_number, invoice_number_normalized, issue_date, amount_ht, tva_amount, amount_ttc, client_name, status, candidates)
         VALUES ($1, $2, CURRENT_DATE, '1500.00', '300.00', '1800.00', 'Ms Pay Client', 'pending_review', $3) RETURNING id`,
        [`F-E2E-${uniq}`, `fe2e${uniq}`.toLowerCase(), JSON.stringify(candidates)],
      );
      const invoiceId = invRows[0].id as number;

      // "Client paid" suggestion for the already-invoiced milestone m2.
      const { rows: sugRows } = await db.query(
        `INSERT INTO milestone_payment_suggestions
           (milestone_id, project_id, architect_fee_invoice_id, email_message_id, email_thread_id,
            sender_email, email_date, matched_excerpt, suggested_amount, suggested_date, status)
         VALUES ($1, $2, NULL, $3, $4, 'client@exemple.fr', NOW(), 'virement effectué ce jour', '3600.00', '2026-08-14', 'pending_review')
         RETURNING id`,
        [m2, project.id, `e2e-ms-sug-${uniq}@mail.test`, `e2e-ms-thread-${uniq}`],
      );
      const suggestionId = sugRows[0].id as number;
      s = { projectId: project.id, contractId, m1, m2, invoiceId, suggestionId };

      const page = await context.newPage();

      // ------------------------------------------------------------------
      // Phase 1 — visibility: dashboard alert + Honoraires badge/banner.
      // ------------------------------------------------------------------
      await page.goto("/");
      await expect(page.getByTestId("alert-pending-fee-invoices")).toBeVisible();

      await page.goto("/honoraires");
      await expect(page.getByTestId("badge-pending-fee-invoices-count")).toBeVisible();
      await expect(page.getByTestId("banner-pending-fee-invoices")).toBeVisible();
      const bannerCard = page.getByTestId(`card-fee-invoice-${invoiceId}`);
      await expect(bannerCard).toBeVisible();

      // ------------------------------------------------------------------
      // Phase 2 — confirm from the banner: project preselected (high
      // confidence), pick milestone m1, Confirmer → milestone invoiced.
      // ------------------------------------------------------------------
      await page.getByTestId(`select-fee-invoice-milestone-${invoiceId}`).click();
      await page.getByRole("option", { name: /Ouverture de dossier/ }).click();
      await page.getByTestId(`button-fee-invoice-confirm-${invoiceId}`).click();
      await expect(bannerCard).toHaveCount(0);
      const { rows: m1After } = await db.query("SELECT status, invoiced_at FROM design_contract_milestones WHERE id = $1", [m1]);
      expect(m1After[0].status).toBe("invoiced");
      expect(m1After[0].invoiced_at).not.toBeNull();

      // ------------------------------------------------------------------
      // Phase 3 — project card: suggestion chip on m2, confirm → paid with
      // paidAt from the suggested date.
      // ------------------------------------------------------------------
      await page.goto(`/projets/${project.id}`);
      const sugChip = page.getByTestId(`suggestion-milestone-paid-${m2}`);
      await expect(sugChip).toBeVisible();
      await expect(sugChip).toContainText("client@exemple.fr");
      await page.getByTestId(`button-suggestion-confirm-${suggestionId}`).click();
      await expect(sugChip).toHaveCount(0);
      await expect(page.getByTestId(`badge-milestone-status-${m2}`)).toHaveText("Paid");
      const { rows: m2After } = await db.query(
        "SELECT status, to_char(paid_at, 'YYYY-MM-DD') AS paid_day FROM design_contract_milestones WHERE id = $1",
        [m2],
      );
      expect(m2After[0].status).toBe("paid");
      expect(m2After[0].paid_day).toBe("2026-08-14");
      const { rows: sugAfter } = await db.query("SELECT status FROM milestone_payment_suggestions WHERE id = $1", [suggestionId]);
      expect(sugAfter[0].status).toBe("confirmed");

      // ------------------------------------------------------------------
      // Phase 4 — manual "Mark paid" on the now-invoiced m1.
      // ------------------------------------------------------------------
      await expect(page.getByTestId(`badge-milestone-status-${m1}`)).toHaveText("Invoiced");
      await page.getByTestId(`button-mark-paid-${m1}`).click();
      await expect(page.getByTestId(`badge-milestone-status-${m1}`)).toHaveText("Paid");
      const { rows: m1Paid } = await db.query("SELECT status, paid_at FROM design_contract_milestones WHERE id = $1", [m1]);
      expect(m1Paid[0].status).toBe("paid");
      expect(m1Paid[0].paid_at).not.toBeNull();

      // ------------------------------------------------------------------
      // Phase 5 — race: manual PATCH paid vs suggestion confirm on the SAME
      // milestone must stay coherent (no deadlock, no double flip, paidAt
      // consistent with whichever path won, no open suggestions left).
      // ------------------------------------------------------------------
      const { rows: m3Rows } = await db.query(
        `INSERT INTO design_contract_milestones (contract_id, sequence, label_fr, percentage, amount_ttc, trigger_event, status, reached_at, invoiced_at)
         VALUES ($1, 3, 'Phase APD', 25.00, '2700.00', 'manual', 'invoiced', NOW(), NOW()) RETURNING id`,
        [contractId],
      );
      const m3 = m3Rows[0].id as number;
      const { rows: raceSugRows } = await db.query(
        `INSERT INTO milestone_payment_suggestions
           (milestone_id, project_id, email_message_id, email_thread_id, sender_email, email_date,
            matched_excerpt, suggested_amount, suggested_date, status)
         VALUES ($1, $2, $3, $4, 'client@exemple.fr', NOW(), 'paiement effectué', '2700.00', '2026-08-10', 'pending_review')
         RETURNING id`,
        [m3, project.id, `e2e-ms-race-${uniq}@mail.test`, `e2e-ms-race-thread-${uniq}`],
      );
      const raceSugId = raceSugRows[0].id as number;

      const [manualRes, confirmRes] = await Promise.all([
        api.patch(`/api/design-contracts/milestones/${m3}`, { data: { status: "paid" } }),
        api.post(`/api/milestone-payment-suggestions/${raceSugId}/confirm`, { data: {} }),
      ]);
      // Exactly one path wins; the loser gets a clean 409 (never a 500/deadlock).
      const statuses = [manualRes.status(), confirmRes.status()].sort();
      expect(statuses[0]).toBe(200);
      expect(statuses[1]).toBe(409);

      const { rows: m3After } = await db.query(
        "SELECT status, to_char(paid_at, 'YYYY-MM-DD') AS paid_day FROM design_contract_milestones WHERE id = $1",
        [m3],
      );
      expect(m3After[0].status).toBe("paid");
      const { rows: raceSugAfter } = await db.query(
        "SELECT status FROM milestone_payment_suggestions WHERE id = $1",
        [raceSugId],
      );
      if (confirmRes.status() === 200) {
        // Suggestion won: paidAt is the email-derived date and stays intact.
        expect(m3After[0].paid_day).toBe("2026-08-10");
        expect(raceSugAfter[0].status).toBe("confirmed");
      } else {
        // Manual won: suggestion was dismissed atomically, paidAt is today.
        expect(raceSugAfter[0].status).toBe("dismissed");
        expect(m3After[0].paid_day).not.toBe("2026-08-10");
      }

      // A later status PATCH can never regress the terminal paid state.
      const regress = await api.patch(`/api/design-contracts/milestones/${m3}`, {
        data: { status: "invoiced" },
      });
      expect(regress.status()).toBe(409);
      const { rows: m3Still } = await db.query("SELECT status FROM design_contract_milestones WHERE id = $1", [m3]);
      expect(m3Still[0].status).toBe("paid");

      // ------------------------------------------------------------------
      // Phase 6 — race: manual paid vs a concurrent ordinary status PATCH.
      // Whatever the interleaving, the milestone must end paid (the PATCH
      // either lands before the flip or gets a clean 409 CAS miss).
      // ------------------------------------------------------------------
      const { rows: m4Rows } = await db.query(
        `INSERT INTO design_contract_milestones (contract_id, sequence, label_fr, percentage, amount_ttc, trigger_event, status, reached_at, invoiced_at)
         VALUES ($1, 4, 'Phase PRO', 25.00, '2700.00', 'manual', 'invoiced', NOW(), NOW()) RETURNING id`,
        [contractId],
      );
      const m4 = m4Rows[0].id as number;
      const [paidRes, patchRes] = await Promise.all([
        api.patch(`/api/design-contracts/milestones/${m4}`, { data: { status: "paid" } }),
        api.patch(`/api/design-contracts/milestones/${m4}`, { data: { status: "reached" } }),
      ]);
      expect([200, 409]).toContain(paidRes.status());
      expect([200, 409]).toContain(patchRes.status());
      // If the ordinary PATCH won the race, the paid request must still have
      // succeeded afterwards or failed cleanly — but paid, once set, sticks.
      const { rows: m4After } = await db.query("SELECT status FROM design_contract_milestones WHERE id = $1", [m4]);
      if (paidRes.status() === 200) {
        expect(m4After[0].status).toBe("paid");
      } else {
        // paid lost only if the milestone left a payable state mid-flight —
        // impossible here (reached is payable), so paid must have succeeded.
        expect(paidRes.status()).toBe(200);
      }
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
