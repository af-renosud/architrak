import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

async function devLogin(api: APIRequestContext, email: string) {
  const response = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    response.ok(),
    `dev-login failed (${response.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

interface Seed {
  projectId: number;
  contractId: number;
}

async function cleanup(db: Client, seed: Seed | null) {
  if (!seed) return;
  const statements: Array<[string, unknown[]]> = [
    ["DELETE FROM milestone_payment_suggestions WHERE project_id = $1", [seed.projectId]],
    ["DELETE FROM architect_fee_invoices WHERE project_id = $1", [seed.projectId]],
    ["DELETE FROM fee_entries WHERE fee_id IN (SELECT id FROM fees WHERE project_id = $1)", [seed.projectId]],
    ["DELETE FROM fees WHERE project_id = $1", [seed.projectId]],
    ["DELETE FROM design_contract_milestones WHERE contract_id = $1", [seed.contractId]],
    ["DELETE FROM design_contracts WHERE id = $1", [seed.contractId]],
    ["DELETE FROM projects WHERE id = $1", [seed.projectId]],
  ];
  for (const [sql, params] of statements) {
    try {
      await db.query(sql, params);
    } catch (error) {
      console.warn("[milestone workflow cleanup] swallowed:", (error as Error).message);
    }
  }
}

test.describe("staged design milestone payments", () => {
  test("records invoice, confirms payment, completes legacy details, and persists both read views", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-staged-milestone-${unique}@local.test`;
    const projectName = `Staged milestone ${unique}`;
    const invoiceNumber = `FA-E2E-${unique}`;
    const historicalInvoiceNumber = `LEG-E2E-${unique}`;
    const raceInvoiceNumber = `RACE-E2E-${unique}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    let seed: Seed | null = null;

    try {
      const api = context.request;
      await devLogin(api, email);
      const { rows: userRows } = await db.query("SELECT id FROM users WHERE email = $1", [email]);
      const userId = userRows[0].id as number;

      const projectResponse = await api.post("/api/projects", {
        data: { name: projectName, code: `STAGE-${unique}`, clientName: "Staged Milestone Client" },
      });
      expect(projectResponse.ok()).toBe(true);
      const project = (await projectResponse.json()) as { id: number };

      const { rows: contractRows } = await db.query(
        `INSERT INTO design_contracts
           (project_id, storage_key, original_filename, total_ht, total_tva, total_ttc, tva_rate, uploaded_by_user_id)
         VALUES ($1, $2, 'staged-contract.pdf', '9000.00', '1800.00', '10800.00', '20.00', $3)
         RETURNING id`,
        [project.id, `design-contracts/e2e/${unique}.pdf`, userId],
      );
      const contractId = contractRows[0].id as number;
      const { rows: milestoneRows } = await db.query(
        `INSERT INTO design_contract_milestones
           (contract_id, sequence, label_fr, percentage, amount_ttc, trigger_event, status, reached_at, paid_at)
         VALUES
           ($1, 1, 'Dossier ouvert', 25.00, '2700.00', 'manual', 'pending', NULL, NULL),
           ($1, 2, 'Jalon historique', 25.00, '2700.00', 'manual', 'paid', NOW(), '2025-12-22'),
           ($1, 3, 'Garde de doublon', 25.00, '2700.00', 'manual', 'reached', NOW(), NULL),
           ($1, 4, 'Paiement concurrent', 25.00, '2700.00', 'manual', 'reached', NOW(), NULL)
         RETURNING id, sequence`,
        [contractId],
      );
      const milestoneBySequence = new Map<number, number>(
        milestoneRows.map((row) => [Number(row.sequence), Number(row.id)]),
      );
      const primaryId = milestoneBySequence.get(1)!;
      const legacyId = milestoneBySequence.get(2)!;
      const duplicateId = milestoneBySequence.get(3)!;
      const raceId = milestoneBySequence.get(4)!;
      seed = { projectId: project.id, contractId };

      const page = await context.newPage();
      await page.goto(`/projets/${project.id}`);

      // Pending → Reached. Neither legacy paid PATCH nor the dedicated payment
      // operation may skip the invoice stage.
      await expect(page.getByTestId(`badge-milestone-status-${primaryId}`)).toHaveText("Pending");
      await page.getByTestId(`button-mark-reached-${primaryId}`).click();
      await expect(page.getByTestId(`badge-milestone-status-${primaryId}`)).toHaveText("Reached");

      const directPaid = await api.patch(`/api/design-contracts/milestones/${primaryId}`, {
        data: { status: "paid" },
      });
      expect(directPaid.status()).toBe(409);
      const missingInvoicePayment = await api.post(
        `/api/design-contracts/milestones/${primaryId}/payment`,
        { data: { paymentDate: "2026-08-19" } },
      );
      expect(missingInvoicePayment.status()).toBe(409);

      // Reached → Invoiced through the required dialog.
      await page.getByTestId(`button-record-invoice-${primaryId}`).click();
      await expect(page.getByTestId("dialog-record-invoice")).toBeVisible();
      await expect(page.getByTestId("button-submit-record-invoice")).toBeDisabled();
      await page.getByTestId("input-invoice-number").fill(invoiceNumber);
      await expect(page.getByTestId("button-submit-record-invoice")).toBeDisabled();
      await page.getByTestId("input-invoice-date").fill("2026-08-18");
      await page.getByTestId("input-invoice-notes").fill("Facture envoyée au client");
      await page.getByTestId("button-submit-record-invoice").click();
      await expect(page.getByTestId("dialog-record-invoice")).toHaveCount(0);
      await expect(page.getByTestId(`badge-milestone-status-${primaryId}`)).toHaveText("Invoiced");
      await expect(page.getByTestId(`text-milestone-invoice-number-${primaryId}`)).toContainText(
        invoiceNumber,
      );
      await expect(page.getByTestId(`text-milestone-invoice-date-${primaryId}`)).toBeVisible();

      // Invoiced → Paid. The saved invoice context is visible and the payment
      // date is prefilled before the user confirms.
      await page.getByTestId(`button-mark-paid-${primaryId}`).click();
      await expect(page.getByTestId("dialog-mark-paid")).toBeVisible();
      await expect(page.getByTestId("text-payment-dialog-invoice-number")).toHaveText(invoiceNumber);
      await expect(page.getByTestId("text-payment-dialog-invoice-date")).not.toHaveText(
        "Invoice date unavailable",
      );
      await expect(page.getByTestId("input-payment-date")).not.toHaveValue("");
      await page.getByTestId("input-payment-date").fill("2026-08-19");
      await page.getByTestId("input-payment-notes").fill("Virement reçu");
      await page.getByTestId("button-submit-mark-paid").click();
      await expect(page.getByTestId("dialog-mark-paid")).toHaveCount(0);
      await expect(page.getByTestId(`badge-milestone-status-${primaryId}`)).toHaveText("Paid");
      await expect(page.getByTestId(`text-milestone-payment-date-${primaryId}`)).toBeVisible();
      await expect(page.getByTestId(`text-milestone-notes-${primaryId}`)).toContainText(
        "Facture envoyée au client",
      );
      await expect(page.getByTestId(`text-milestone-notes-${primaryId}`)).toContainText(
        "Virement reçu",
      );

      // A paid legacy milestone can gain complete historical metadata while
      // remaining terminal.
      await expect(page.getByTestId(`button-add-details-${legacyId}`)).toBeVisible();
      await page.getByTestId(`button-add-details-${legacyId}`).click();
      await expect(page.getByTestId("dialog-add-details")).toBeVisible();
      await expect(page.getByTestId("button-submit-add-details")).toBeDisabled();
      await page.getByTestId("input-details-invoice-number").fill(historicalInvoiceNumber);
      await page.getByTestId("input-details-invoice-date").fill("2025-12-10");
      await page.getByTestId("input-details-payment-date").fill("2025-12-22");
      await page.getByTestId("input-details-notes").fill("Reprise historique validée");
      await page.getByTestId("button-submit-add-details").click();
      await expect(page.getByTestId("dialog-add-details")).toHaveCount(0);
      await expect(page.getByTestId(`badge-milestone-status-${legacyId}`)).toHaveText("Paid");
      await expect(page.getByTestId(`button-add-details-${legacyId}`)).toHaveCount(0);
      await expect(page.getByTestId(`text-milestone-invoice-number-${legacyId}`)).toContainText(
        historicalInvoiceNumber,
      );

      // Normalized references are global, so formatting differences cannot
      // attach the same invoice to another milestone.
      const duplicateResponse = await api.post(
        `/api/design-contracts/milestones/${duplicateId}/invoice`,
        {
          data: {
            invoiceNumber: invoiceNumber.toLowerCase().replaceAll("-", " "),
            invoiceDate: "2026-08-19",
          },
        },
      );
      expect(duplicateResponse.status()).toBe(409);
      const { rows: duplicateRows } = await db.query(
        "SELECT status FROM design_contract_milestones WHERE id = $1",
        [duplicateId],
      );
      expect(duplicateRows[0].status).toBe("reached");

      // Two payment confirmations cannot both win, and the winner atomically
      // clears an open email suggestion.
      const raceInvoice = await api.post(`/api/design-contracts/milestones/${raceId}/invoice`, {
        data: {
          invoiceNumber: raceInvoiceNumber,
          invoiceDate: "2026-08-12",
        },
      });
      expect(raceInvoice.status()).toBe(201);
      const { rows: suggestionRows } = await db.query(
        `INSERT INTO milestone_payment_suggestions
           (milestone_id, project_id, email_message_id, email_thread_id, sender_email, email_date,
            suggested_amount, suggested_date, status)
         VALUES ($1, $2, $3, $4, 'client@example.test', NOW(), '2700.00', '2026-08-15', 'pending_review')
         RETURNING id`,
        [raceId, project.id, `stage-race-${unique}@example.test`, `stage-race-thread-${unique}`],
      );
      const [raceA, raceB] = await Promise.all([
        api.post(`/api/design-contracts/milestones/${raceId}/payment`, {
          data: { paymentDate: "2026-08-16", notes: "Premier clic" },
        }),
        api.post(`/api/design-contracts/milestones/${raceId}/payment`, {
          data: { paymentDate: "2026-08-17", notes: "Second clic" },
        }),
      ]);
      expect([raceA.status(), raceB.status()].sort()).toEqual([200, 409]);
      const { rows: suggestionAfterRows } = await db.query(
        "SELECT status FROM milestone_payment_suggestions WHERE id = $1",
        [suggestionRows[0].id],
      );
      expect(suggestionAfterRows[0].status).toBe("dismissed");

      // Refresh proves persistence on the project card.
      await page.reload();
      await expect(page.getByTestId(`badge-milestone-status-${primaryId}`)).toHaveText("Paid");
      await expect(page.getByTestId(`text-milestone-invoice-number-${primaryId}`)).toContainText(
        invoiceNumber,
      );
      await expect(page.getByTestId(`text-milestone-invoice-date-${primaryId}`)).toBeVisible();
      await expect(page.getByTestId(`text-milestone-payment-date-${primaryId}`)).toBeVisible();
      await expect(page.getByTestId(`text-milestone-notes-${primaryId}`)).toContainText(
        "Virement reçu",
      );

      // The Honoraires summary exposes the same generic details.
      await page.goto("/honoraires");
      await page.getByTestId("select-fee-project-filter").click();
      await page.getByRole("option", { name: new RegExp(projectName) }).click();
      await expect(page.getByTestId("card-design-contract-milestones")).toBeVisible();
      await expect(
        page.getByTestId(`text-fee-milestone-invoice-number-${primaryId}`),
      ).toContainText(invoiceNumber);
      await expect(page.getByTestId(`text-fee-milestone-invoice-date-${primaryId}`)).toBeVisible();
      await expect(page.getByTestId(`text-fee-milestone-payment-date-${primaryId}`)).toBeVisible();
      await expect(page.getByTestId(`text-fee-milestone-notes-${primaryId}`)).toContainText(
        "Virement reçu",
      );
      await expect(
        page.getByTestId(`text-fee-milestone-invoice-number-${legacyId}`),
      ).toContainText(historicalInvoiceNumber);
      await expect(page.getByTestId(`text-fee-milestone-payment-date-${legacyId}`)).toBeVisible();
      await expect(page.getByTestId(`text-fee-milestone-notes-${legacyId}`)).toContainText(
        "Reprise historique validée",
      );
    } finally {
      try {
        await cleanup(db, seed);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});