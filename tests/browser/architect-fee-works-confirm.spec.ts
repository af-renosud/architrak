import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the works-commission binding on the architect fee-invoice
 * review page (Task #432, feature from Task #430).
 *
 * Seeds (directly in the DB) a project + contractor + devis + works fee with
 * one PENDING `fee_entries` row, plus a caught `architect_fee_invoices`
 * evidence row whose `candidates` payload offers that entry as a
 * works-commission suggestion. Then drives the UI:
 *   - /honoraires/factures-detectees shows the evidence card,
 *   - the devis reference is visible (text-fee-invoice-devis-ref-*),
 *   - the binding dropdown offers the "Commission travaux" option
 *     (option-fee-invoice-works-<evidence>-<entry>, value "w:<id>"),
 *   - confirming fires POST /confirm with { projectId, feeEntryId } and the
 *     success toast reports the works reconciliation,
 *   - the fee entry lands `invoiced` in the DB and the evidence shows as
 *     Confirmée under the confirmed filter.
 *
 * REQUIRES the server to run with ENABLE_DEV_LOGIN_FOR_E2E=true.
 * All seeded rows are deleted in the finally block regardless of pass/fail.
 */

const SEED_PREFIX = "e2e-fee-works-";

/** Mirrors shared/intake-dedup normalizeRef (lowercase alnum). */
function normalizeRef(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

interface Seeded {
  projectId: number;
  contractorId: number;
  devisId: number;
  feeId: number;
  feeEntryId: number;
  evidenceId: number;
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const devisRef = `DEV-E2E-${uniq}`;
  const invoiceRef = `FH-E2E-${uniq}`;
  const contractorName = `${SEED_PREFIX}maconnerie-${uniq}`;

  const projectRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, fee_percentage, client_contact_email)
     VALUES ($1, $2, $3, '7.00', $4) RETURNING id`,
    [
      `${SEED_PREFIX}project-${uniq}`,
      `${SEED_PREFIX}${uniq}`,
      "Client Works E2E",
      `${SEED_PREFIX}${uniq}@local.test`,
    ],
  );
  const projectId = projectRes.rows[0].id;

  const contractorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
    [contractorName],
  );
  const contractorId = contractorRes.rows[0].id;

  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis (project_id, contractor_id, devis_code, devis_number, description_fr, amount_ht, amount_ttc)
     VALUES ($1, $2, $3, $4, 'Gros œuvre E2E works confirm', '5000.00', '6000.00') RETURNING id`,
    [projectId, contractorId, `DC-E2E-${uniq}`, devisRef],
  );
  const devisId = devisRes.rows[0].id;

  const feeRes = await db.query<{ id: number }>(
    `INSERT INTO fees (project_id, fee_type, base_amount_ht, fee_rate, fee_amount_ht, invoiced_amount, remaining_amount, status)
     VALUES ($1, 'works_percentage', '5000.00', '7.00', '350.00', '0.00', '350.00', 'active') RETURNING id`,
    [projectId],
  );
  const feeId = feeRes.rows[0].id;

  const entryRes = await db.query<{ id: number }>(
    `INSERT INTO fee_entries (fee_id, devis_id, base_ht, fee_rate, fee_amount, status)
     VALUES ($1, $2, '5000.00', '7.00', '350.00', 'pending') RETURNING id`,
    [feeId, devisId],
  );
  const feeEntryId = entryRes.rows[0].id;

  // Candidates payload mirrors what capture ranking produces — a project
  // suggestion plus the pending works entry under worksFees.
  const candidates = {
    projects: [
      {
        projectId,
        score: 10,
        reasons: ["seeded for e2e"],
        name: `${SEED_PREFIX}project-${uniq}`,
        clientName: "Client Works E2E",
      },
    ],
    highConfidenceProjectId: projectId,
    milestones: {},
    worksFees: {
      [String(projectId)]: [
        {
          feeEntryId,
          score: 10,
          reasons: ["devis reference match (seeded)"],
          feeAmount: "350.00",
          contractorName,
          devisNumber: devisRef,
          contractorInvoiceNumber: null,
        },
      ],
    },
  };

  const evidenceRes = await db.query<{ id: number }>(
    `INSERT INTO architect_fee_invoices
       (invoice_number, invoice_number_normalized, issue_date, amount_ht, tva_amount, amount_ttc,
        client_name, devis_number, devis_number_normalized, file_name, source, status,
        identity_reason, candidates)
     VALUES ($1, $2, '2026-08-10', '350.00', '70.00', '420.00',
             'Client Works E2E', $3, $4, $5, 'gmail', 'pending_review',
             'seeded e2e fixture', $6::jsonb)
     RETURNING id`,
    [
      invoiceRef,
      normalizeRef(invoiceRef),
      devisRef,
      normalizeRef(devisRef),
      `${invoiceRef}.pdf`,
      JSON.stringify(candidates),
    ],
  );
  const evidenceId = evidenceRes.rows[0].id;

  return { projectId, contractorId, devisId, feeId, feeEntryId, evidenceId };
}

async function cleanup(db: Client, s: Seeded | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM architect_fee_invoice_events WHERE architect_fee_invoice_id = $1", [s.evidenceId]],
    ["DELETE FROM architect_fee_invoices WHERE id = $1", [s.evidenceId]],
    ["DELETE FROM fee_entries WHERE id = $1", [s.feeEntryId]],
    ["DELETE FROM fees WHERE id = $1", [s.feeId]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[fee-works-confirm cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Architect fee invoices — works-commission binding (task #432)", () => {
  test("review page binds a caught invoice to a works commission and invoices the entry", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `${SEED_PREFIX}${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let seeded: Seeded | null = null;
    try {
      await devLogin(context.request, email);
      seeded = await seed(db, uniq);
      const { evidenceId, feeEntryId, projectId } = seeded;

      const page = await context.newPage();
      await page.goto("/honoraires/factures-detectees");

      const card = page.getByTestId(`card-fee-invoice-${evidenceId}`);
      await expect(card).toBeVisible({ timeout: 10_000 });

      // Devis reference is surfaced on the evidence card (Task #430 column).
      await expect(page.getByTestId(`text-fee-invoice-devis-ref-${evidenceId}`)).toHaveText(
        new RegExp(`Réf\\. devis\\s*:\\s*DEV-E2E-${uniq}`),
      );

      // Project preselected via highConfidenceProjectId; still assert it.
      await expect(page.getByTestId(`select-fee-invoice-project-${evidenceId}`)).toContainText(
        `${SEED_PREFIX}project-${uniq}`,
      );

      // Open the binding dropdown and pick the works-commission option.
      await page.getByTestId(`select-fee-invoice-milestone-${evidenceId}`).click();
      const worksOption = page.getByTestId(`option-fee-invoice-works-${evidenceId}-${feeEntryId}`);
      await expect(worksOption).toBeVisible();
      await expect(worksOption).toContainText("Commission travaux");
      await expect(worksOption).toContainText(`devis DEV-E2E-${uniq}`);
      await worksOption.click();

      // Confirm must POST { projectId, feeEntryId } (the "w:<id>" contract).
      const [confirmRes] = await Promise.all([
        page.waitForResponse(
          (res) =>
            res.url().includes(`/api/architect-fee-invoices/${evidenceId}/confirm`) &&
            res.request().method() === "POST",
        ),
        page.getByTestId(`button-fee-invoice-confirm-${evidenceId}`).click(),
      ]);
      expect(confirmRes.status(), await confirmRes.text()).toBe(200);
      const reqBody = confirmRes.request().postDataJSON() as Record<string, unknown>;
      expect(reqBody).toEqual({ projectId, feeEntryId });
      const resBody = (await confirmRes.json()) as {
        reconciliation: string;
        feeEntryId: number;
        milestoneId: number | null;
      };
      expect(resBody.reconciliation).toBe("invoiced_works_entry");
      expect(resBody.feeEntryId).toBe(feeEntryId);
      expect(resBody.milestoneId).toBeNull();

      // Success toast reports the works reconciliation wording.
      await expect(page.getByText("Facture confirmée", { exact: true })).toBeVisible({
        timeout: 5_000,
      });
      await expect(
        page.getByText(`Commission travaux facturée — écriture existante enregistrée (n°${feeEntryId}).`, {
          exact: true,
        }),
      ).toBeVisible();

      // The entry is invoiced in the DB with the extracted ref/date.
      const entry = await db.query<{ status: string; date_invoiced: string; pennylane_invoice_number: string }>(
        `SELECT status, date_invoiced::text, pennylane_invoice_number FROM fee_entries WHERE id = $1`,
        [feeEntryId],
      );
      expect(entry.rows[0]?.status).toBe("invoiced");
      expect(entry.rows[0]?.date_invoiced).toBe("2026-08-10");
      expect(entry.rows[0]?.pennylane_invoice_number).toBe(`FH-E2E-${uniq}`);

      // Card leaves the pending queue and shows Confirmée under the
      // confirmed filter.
      await expect(page.getByTestId(`card-fee-invoice-${evidenceId}`)).toHaveCount(0, {
        timeout: 10_000,
      });
      await page.getByTestId("select-fee-invoice-status").click();
      await page.getByRole("option", { name: "Confirmées" }).click();
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId(`badge-fee-invoice-status-${evidenceId}`)).toHaveText("Confirmée");
    } finally {
      try {
        await cleanup(db, seeded);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
