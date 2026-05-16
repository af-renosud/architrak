import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the Pennylane dry-run push flow (Task #218 / #219).
 *
 * Seeds an approved invoice + fee + fee_entry on a fresh project, clicks
 * the "Invoice (dry-run)" button on the Outstanding Architect Fees panel
 * inside the project's Honoraires tab, then waits for the three
 * pennylane_pushes rows (`customer`, `customer_invoice`, `email_send`) to
 * settle into state='succeeded' with `dry-run:<kind>:<docId>` sentinel
 * ids. Asserts the mirror columns on `projects` and `fee_entries` are
 * written by the dry-run handlers.
 *
 * The test deliberately uses the DRY-RUN feature flag so it never hits
 * the real Pennylane API and never sends a real email — the chain runs
 * end-to-end in-process with sentinel ids.
 *
 * REQUIRES the server to be booted with:
 *   - ENABLE_DEV_LOGIN_FOR_E2E=true   (dev-login backdoor for seeding)
 *   - PENNYLANE_API_KEY=<anything>    (makes isPennylaneConfigured() true)
 *   - PENNYLANE_PUSH_ENABLED=true
 *   - PENNYLANE_DRY_RUN=true
 *   - PENNYLANE_PROJECT_WHITELIST unset (or include the seeded project id)
 *
 * The spec pre-checks /api/pennylane/feature-flags and fails fast with
 * a clear message when the flags are not in the expected state, so it
 * runs hermetically in CI without leaving stale state. All seeded rows
 * (incl. the pennylane_pushes the click creates) are deleted in the
 * finally block regardless of pass/fail.
 */

const SEED_PREFIX = "e2e-pennylane-dryrun-";

interface Seeded {
  projectId: number;
  contractorId: number;
  devisId: number;
  invoiceId: number;
  feeId: number;
  feeEntryId: number;
}

interface FeatureFlags {
  configured: boolean;
  pushEnabled: boolean;
  dryRun: boolean;
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function fetchFeatureFlags(api: APIRequestContext): Promise<FeatureFlags> {
  const res = await api.get("/api/pennylane/feature-flags");
  expect(res.ok(), `feature-flags probe failed: ${res.status()}`).toBe(true);
  return (await res.json()) as FeatureFlags;
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  // Project with explicit feePercentage (so approve creates a fee_entry)
  // and a client_contact_email (so the dry-run email_send handler doesn't
  // permanently fail before logging the sentinel).
  const projectRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, fee_percentage, client_contact_email)
     VALUES ($1, $2, $3, '10.00', $4)
     RETURNING id`,
    [
      `${SEED_PREFIX}project-${uniq}`,
      `${SEED_PREFIX}${uniq}`,
      "Pennylane Dry-Run Client",
      `${SEED_PREFIX}${uniq}@local.test`,
    ],
  );
  const projectId = projectRes.rows[0].id;

  const contractorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, email)
     VALUES ($1, $2) RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`, `${SEED_PREFIX}co-${uniq}@local.test`],
  );
  const contractorId = contractorRes.rows[0].id;

  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc, invoicing_mode)
     VALUES ($1, $2, $3, $4, '1000.00', '1200.00', 'mode_b')
     RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D-${uniq}`, "Pennylane dry-run devis"],
  );
  const devisId = devisRes.rows[0].id;

  const invoiceRes = await db.query<{ id: number }>(
    `INSERT INTO invoices
       (devis_id, contractor_id, project_id, invoice_number,
        amount_ht, tva_amount, amount_ttc, date_issued, status)
     VALUES ($1, $2, $3, $4, '1000.00', '200.00', '1200.00', CURRENT_DATE, 'approved')
     RETURNING id`,
    [devisId, contractorId, projectId, `${SEED_PREFIX}INV-${uniq}`],
  );
  const invoiceId = invoiceRes.rows[0].id;

  // Synthesise the fee + fee_entry that approveInvoice() would normally
  // create. Doing it directly keeps the seed deterministic and avoids
  // coupling to the approval route's side-effects.
  const feeRes = await db.query<{ id: number }>(
    `INSERT INTO fees
       (project_id, fee_type, base_amount_ht, fee_rate, fee_amount_ht,
        invoiced_amount, remaining_amount, status)
     VALUES ($1, 'works_percentage', '1000.00', '10.00', '100.00',
             '0.00', '100.00', 'active')
     RETURNING id`,
    [projectId],
  );
  const feeId = feeRes.rows[0].id;

  const feeEntryRes = await db.query<{ id: number }>(
    `INSERT INTO fee_entries
       (fee_id, invoice_id, devis_id, base_ht, fee_rate, fee_amount,
        date_invoiced, status)
     VALUES ($1, $2, $3, '1000.00', '10.00', '100.00', CURRENT_DATE, 'pending')
     RETURNING id`,
    [feeId, invoiceId, devisId],
  );
  const feeEntryId = feeEntryRes.rows[0].id;

  return { projectId, contractorId, devisId, invoiceId, feeId, feeEntryId };
}

async function cleanup(db: Client, s: Seeded | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    // Push rows the click created (customer rows keyed by projectId,
    // invoice + email rows keyed by feeEntryId).
    ["DELETE FROM pennylane_pushes WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM fee_entries WHERE id = $1", [s.feeEntryId]],
    ["DELETE FROM fees WHERE id = $1", [s.feeId]],
    ["DELETE FROM invoices WHERE id = $1", [s.invoiceId]],
    ["DELETE FROM devis WHERE id = $1", [s.devisId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[pennylane-dry-run cleanup] swallowed:", (err as Error).message);
    }
  }
}

interface PushRow {
  kind: string;
  state: string;
  pennylane_id: string | null;
  dry_run: boolean;
  attempts: number;
}

async function fetchPushes(db: Client, projectId: number, feeEntryId: number): Promise<PushRow[]> {
  const { rows } = await db.query<PushRow>(
    `SELECT kind, state, pennylane_id, dry_run, attempts
       FROM pennylane_pushes
      WHERE (kind = 'customer' AND doc_id = $1)
         OR (kind IN ('customer_invoice','email_send') AND doc_id = $2)
      ORDER BY kind`,
    [projectId, feeEntryId],
  );
  return rows;
}

async function waitForChainSucceeded(
  db: Client,
  projectId: number,
  feeEntryId: number,
  timeoutMs = 30_000,
): Promise<PushRow[]> {
  const deadline = Date.now() + timeoutMs;
  let last: PushRow[] = [];
  while (Date.now() < deadline) {
    last = await fetchPushes(db, projectId, feeEntryId);
    const byKind = new Map(last.map((r) => [r.kind, r]));
    const allThree =
      byKind.has("customer") && byKind.has("customer_invoice") && byKind.has("email_send");
    if (allThree && last.every((r) => r.state === "succeeded")) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Pennylane push chain did not settle in ${timeoutMs}ms. Last state: ${JSON.stringify(last)}`,
  );
}

test.describe("Pennylane — Invoice (dry-run) end-to-end push chain (task #219)", () => {
  test("clicking Invoice (dry-run) succeeds customer → invoice → email_send and writes mirror columns", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-pennylane-dryrun-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let seeded: Seeded | null = null;
    try {
      // Fail fast if the server isn't running with the dry-run flags
      // armed — without them the UI renders "Mark Invoiced" instead of
      // "Invoice (dry-run)" and the queue handlers no-op.
      const flags = await fetchFeatureFlags(context.request);
      expect(
        flags.pushEnabled && flags.dryRun && flags.configured,
        `Pennylane feature flags must be configured + pushEnabled + dryRun. Got ${JSON.stringify(flags)}. ` +
          `Set PENNYLANE_API_KEY, PENNYLANE_PUSH_ENABLED=true, PENNYLANE_DRY_RUN=true on the server.`,
      ).toBe(true);

      await devLogin(context.request, email);
      seeded = await seed(db, uniq);

      const page = await context.newPage();
      await page.goto(`/projets/${seeded.projectId}?tab=honoraires`);

      // Land on the Honoraires tab and surface the Outstanding panel.
      await page.getByTestId("tab-honoraires").click();
      const row = page.getByTestId(`row-outstanding-entry-${seeded.feeEntryId}`);
      await expect(row).toBeVisible({ timeout: 10_000 });

      const dryRunBtn = page.getByTestId(`button-invoice-now-${seeded.feeEntryId}`);
      await expect(dryRunBtn).toBeVisible();
      // Label proves the UI swapped to the dry-run affordance.
      await expect(dryRunBtn).toContainText(/dry-run/i);

      await dryRunBtn.click();

      // Toast confirms the route accepted the enqueue.
      await expect(
        page.getByText(/Dry-run push enqueued/i).first(),
      ).toBeVisible({ timeout: 5_000 });

      // Wait for the full 3-row chain to settle in 'succeeded'. The
      // sweeper runs every 60s, but enqueueHonorairesPush fires an
      // inline sweep so the chain typically completes in <2s.
      const settled = await waitForChainSucceeded(db, seeded.projectId, seeded.feeEntryId, 30_000);
      const byKind = new Map(settled.map((r) => [r.kind, r]));

      const customer = byKind.get("customer")!;
      const invoice = byKind.get("customer_invoice")!;
      const emailSend = byKind.get("email_send")!;

      expect(customer.state).toBe("succeeded");
      expect(customer.dry_run).toBe(true);
      expect(customer.pennylane_id).toBe(`dry-run:customer:${seeded.projectId}`);

      expect(invoice.state).toBe("succeeded");
      expect(invoice.dry_run).toBe(true);
      expect(invoice.pennylane_id).toBe(`dry-run:invoice:${seeded.feeEntryId}`);

      expect(emailSend.state).toBe("succeeded");
      expect(emailSend.dry_run).toBe(true);
      expect(emailSend.pennylane_id).toBe(`dry-run:email:${seeded.feeEntryId}`);

      // ---------- Mirror-column assertions ----------
      const { rows: projectRows } = await db.query<{ pennylane_customer_id: string | null }>(
        `SELECT pennylane_customer_id FROM projects WHERE id = $1`,
        [seeded.projectId],
      );
      expect(projectRows[0]?.pennylane_customer_id).toBe(
        `dry-run:customer:${seeded.projectId}`,
      );

      const { rows: feeEntryRows } = await db.query<{
        pennylane_invoice_id: string | null;
        pennylane_status: string | null;
        pennylane_pushed_at: Date | null;
      }>(
        `SELECT pennylane_invoice_id, pennylane_status, pennylane_pushed_at
           FROM fee_entries WHERE id = $1`,
        [seeded.feeEntryId],
      );
      expect(feeEntryRows[0]?.pennylane_invoice_id).toBe(
        `dry-run:invoice:${seeded.feeEntryId}`,
      );
      expect(feeEntryRows[0]?.pennylane_status).toBe("dry_run");
      expect(
        feeEntryRows[0]?.pennylane_pushed_at,
        "pennylane_pushed_at must be stamped by the dry-run invoice handler",
      ).not.toBeNull();
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
