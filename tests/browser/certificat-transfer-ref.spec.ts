import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * E2E coverage for the bank-transfer reference on certificat PDFs (task #628).
 *
 * Verifies:
 *   1. The certificat PREVIEW PDF renders the "use this reference for your
 *      payment." label (renderBankingBlock inserts it when transferRef is set).
 *   2. After issuing (sealing via Send), the DB row's `payment_transfer_ref`
 *      column contains the expected formatted string:
 *        "{PROJECT CODE} {certificat ref} / {invoice number}"
 *   3. Opening the certificat detail dialog and clicking "Enregistrer un
 *      paiement" pre-fills the reference input with the stored value so
 *      the architect does not have to copy it manually.
 *
 * Seeds via direct pg; cleans up in finally. Requires NODE_ENV=development,
 * ENABLE_DEV_LOGIN_FOR_E2E=true, E2E_FAKE_GMAIL=true, DATABASE_URL.
 *
 * PDF text is extracted with pdftotext (poppler-utils nix package).
 */

const SEED_PREFIX = "e2e-cert-tref-";

const PDFTOTEXT_BIN =
  "/nix/store/1f2vbia1rg1rh5cs0ii49v3hln9i36rv-poppler-utils-24.02.0/bin/pdftotext";

// A synthetic IBAN that passes the contractor banking gate.
const FAKE_IBAN = "FR7630006000011234567890189";

interface Seeded {
  projectId: number;
  contractorId: number;
  devisId: number;
  invoiceId: number;
  invoiceNumber: string;
  projectCode: string;
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  // Keep the project code short so the transfer ref stays readable in assertions.
  const projectCode = `TREF-${uniq.slice(0, 8).toUpperCase()}`;

  const projRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, client_contact_email, status)
     VALUES ($1, $2, 'E2E Transfer Ref Client', $3, 'active') RETURNING id`,
    [
      `${SEED_PREFIX}project-${uniq}`,
      projectCode,
      `client-tref-${uniq}@example.com`,
    ],
  );
  const projectId = projRes.rows[0].id;

  const ctorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, iban, bic) VALUES ($1, $2, 'BNPAFRPP') RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`, FAKE_IBAN],
  );
  const contractorId = ctorRes.rows[0].id;

  // A marché is required for the certificat deduction engine.
  await db.query(
    `INSERT INTO marches
       (project_id, contractor_id, total_ht, total_ttc, retenue_garantie_percent, status)
     VALUES ($1, $2, '20000.00', '24000.00', '5.00', 'active')`,
    [projectId, contractorId],
  );

  // A lot is required: the send route rejects devis without a lotId.
  const lotRes = await db.query<{ id: number }>(
    `INSERT INTO lots (project_id, lot_number, description_fr, description_uk)
     VALUES ($1, '01', 'Structure', 'Structural works') RETURNING id`,
    [projectId],
  );
  const lotId = lotRes.rows[0].id;

  const devisCode = `${SEED_PREFIX}D-${uniq}`;
  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, description_uk,
        amount_ht, amount_ttc, status, sign_off_stage, lot_id)
     VALUES ($1, $2, $3, 'E2E Transfer Ref Devis', 'E2E Transfer Ref Works',
             '10000.00', '12000.00', 'confirmed', 'client_signed_off', $4)
     RETURNING id`,
    [projectId, contractorId, devisCode, lotId],
  );
  const devisId = devisRes.rows[0].id;

  const invoiceNumber = `TREF-INV-${uniq.slice(0, 8).toUpperCase()}`;
  const invRes = await db.query<{ id: number }>(
    `INSERT INTO invoices
       (devis_id, contractor_id, project_id, invoice_number,
        amount_ht, tva_amount, amount_ttc, status)
     VALUES ($1, $2, $3, $4, '10000.00', '2000.00', '12000.00', 'pending')
     RETURNING id`,
    [devisId, contractorId, projectId, invoiceNumber],
  );
  const invoiceId = invRes.rows[0].id;

  return { projectId, contractorId, devisId, invoiceId, invoiceNumber, projectCode };
}

async function cleanup(db: Client, s: Seeded | null): Promise<void> {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    [`DELETE FROM project_communications WHERE project_id = $1`, [s.projectId]],
    [
      `DELETE FROM certificat_sources
       WHERE certificat_id IN (SELECT id FROM certificats WHERE project_id = $1)`,
      [s.projectId],
    ],
    [`DELETE FROM certificats WHERE project_id = $1`, [s.projectId]],
    [`DELETE FROM invoices WHERE id = $1`, [s.invoiceId]],
    [`DELETE FROM devis WHERE id = $1`, [s.devisId]],
    [`DELETE FROM lots WHERE project_id = $1`, [s.projectId]],
    [`DELETE FROM marches WHERE project_id = $1`, [s.projectId]],
    [`DELETE FROM projects WHERE id = $1`, [s.projectId]],
    [`DELETE FROM contractors WHERE id = $1`, [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[cert-tref cleanup] swallowed:", (err as Error).message);
    }
  }
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function fetchPreviewPdfText(
  api: APIRequestContext,
  certId: number,
): Promise<string> {
  const res = await api.post(`/api/certificats/${certId}/preview`);
  expect(
    res.ok(),
    `Preview fetch failed for cert ${certId}: HTTP ${res.status()}`,
  ).toBe(true);

  const body = await res.body();
  const tmp = join(tmpdir(), `cert-tref-${certId}-${Date.now()}.pdf`);
  try {
    writeFileSync(tmp, body);
    return execFileSync(PDFTOTEXT_BIN, [tmp, "-"], { encoding: "utf-8" });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
  }
}

// ── Acompte path ────────────────────────────────────────────────────────────

const SEED_PREFIX_AC = "e2e-cert-tref-ac-";

interface SeededAcompte {
  projectId: number;
  contractorId: number;
  devisId: number;
  devisCode: string;
  projectCode: string;
}

async function seedAcompte(db: Client, uniq: string): Promise<SeededAcompte> {
  const projectCode = `TREF-AC-${uniq.slice(0, 6).toUpperCase()}`;

  const projRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, client_contact_email, status)
     VALUES ($1, $2, 'E2E Transfer Ref Acompte Client', $3, 'active') RETURNING id`,
    [
      `${SEED_PREFIX_AC}project-${uniq}`,
      projectCode,
      `client-tref-ac-${uniq}@example.com`,
    ],
  );
  const projectId = projRes.rows[0].id;

  const ctorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, iban, bic) VALUES ($1, $2, 'BNPAFRPP') RETURNING id`,
    [`${SEED_PREFIX_AC}contractor-${uniq}`, FAKE_IBAN],
  );
  const contractorId = ctorRes.rows[0].id;

  // A marché is required for the certificat deduction engine.
  await db.query(
    `INSERT INTO marches
       (project_id, contractor_id, total_ht, total_ttc, retenue_garantie_percent, status)
     VALUES ($1, $2, '15000.00', '18000.00', '5.00', 'active')`,
    [projectId, contractorId],
  );

  const lotRes = await db.query<{ id: number }>(
    `INSERT INTO lots (project_id, lot_number, description_fr, description_uk)
     VALUES ($1, '01', 'Fondations', 'Foundations') RETURNING id`,
    [projectId],
  );
  const lotId = lotRes.rows[0].id;

  // The devis code will appear as the suffix in the transfer ref.
  const devisCode = `TREF-AC-D-${uniq.slice(0, 6).toUpperCase()}`;
  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, description_uk,
        amount_ht, amount_ttc, status, sign_off_stage, lot_id,
        acompte_required, acompte_state, acompte_amount_ht)
     VALUES ($1, $2, $3, 'E2E Acompte Transfer Ref Devis', 'E2E Acompte Transfer Ref Works',
             '15000.00', '18000.00', 'confirmed', 'client_signed_off', $4,
             true, 'pending', '3000.00')
     RETURNING id`,
    [projectId, contractorId, devisCode, lotId],
  );
  const devisId = devisRes.rows[0].id;

  return { projectId, contractorId, devisId, devisCode, projectCode };
}

async function cleanupAcompte(db: Client, s: SeededAcompte | null): Promise<void> {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    [`DELETE FROM project_communications WHERE project_id = $1`, [s.projectId]],
    [
      `DELETE FROM certificat_sources
       WHERE certificat_id IN (SELECT id FROM certificats WHERE project_id = $1)`,
      [s.projectId],
    ],
    [`DELETE FROM certificats WHERE project_id = $1`, [s.projectId]],
    [`DELETE FROM devis WHERE id = $1`, [s.devisId]],
    [`DELETE FROM lots WHERE project_id = $1`, [s.projectId]],
    [`DELETE FROM marches WHERE project_id = $1`, [s.projectId]],
    [`DELETE FROM projects WHERE id = $1`, [s.projectId]],
    [`DELETE FROM contractors WHERE id = $1`, [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[cert-tref-ac cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Certificat — bank-transfer reference acompte path (task #631)", () => {
  test(
    "acompte certificat: seal persists paymentTransferRef with devis code; payment dialog pre-fills it",
    async ({ browser }) => {
      const databaseUrl = process.env.DATABASE_URL;
      expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

      const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const email = `${SEED_PREFIX_AC}${uniq}@local.test`;
      const db = new Client({ connectionString: databaseUrl! });
      await db.connect();

      const context = await browser.newContext({
        viewport: { width: 1600, height: 900 },
      });
      let s: SeededAcompte | null = null;

      try {
        await devLogin(context.request, email);
        s = await seedAcompte(db, uniq);

        // ── 1. Create the acompte certificat (no supplier invoice) ────────
        const createRes = await context.request.post(
          `/api/devis/${s.devisId}/acompte/generate-certificat`,
          { data: {} },
        );
        expect(
          createRes.ok(),
          `generate-certificat failed: HTTP ${createRes.status()} – ${await createRes.text()}`,
        ).toBe(true);

        const certRow = await db.query<{ id: number; certificate_ref: string }>(
          `SELECT id, certificate_ref FROM certificats
           WHERE project_id = $1 AND status != 'superseded'
           ORDER BY id DESC LIMIT 1`,
          [s.projectId],
        );
        expect(certRow.rows.length).toBe(1);
        const certId = certRow.rows[0].id;
        const certRef = certRow.rows[0].certificate_ref;

        // ── 2. Preview PDF — must contain the transfer-ref label ──────────
        const pdfText = await fetchPreviewPdfText(context.request, certId);
        expect(pdfText.toUpperCase()).toContain("USE THIS REFERENCE FOR YOUR PAYMENT.");

        // The preview transfer ref suffix is the devis code, not an invoice
        // number.  Check that the devis code substring appears in the PDF.
        // The devis code is short enough that line-wrapping is not a concern.
        const devisCodeSuffix = s.devisCode.slice(s.devisCode.lastIndexOf("-") + 1);
        expect(pdfText).toContain(devisCodeSuffix);

        // ── 3. Issue (seal) the acompte certificat via the send endpoint ──
        // E2E_FAKE_GMAIL=true prevents a real email from being sent.
        const sendRes = await context.request.post(
          `/api/projects/${s.projectId}/certificats/${certId}/send`,
        );
        expect(
          sendRes.ok(),
          `Send failed: HTTP ${sendRes.status()} – ${await sendRes.text()}`,
        ).toBe(true);

        // ── 4. Confirm paymentTransferRef is stored with the devis code ───
        const sealedRow = await db.query<{
          payment_transfer_ref: string | null;
          status: string;
        }>(
          `SELECT payment_transfer_ref, status FROM certificats WHERE id = $1`,
          [certId],
        );
        expect(sealedRow.rows.length).toBe(1);
        const stored = sealedRow.rows[0].payment_transfer_ref;
        expect(
          stored,
          "paymentTransferRef must be non-null after sealing an acompte certificat",
        ).not.toBeNull();

        // Expected format: "{PROJECT CODE} {cert ref} / {devis code}"
        const expectedRef = `${s.projectCode} ${certRef} / ${s.devisCode}`;
        expect(stored).toBe(expectedRef);

        // ── 5. Open detail dialog — payment form pre-fills the ref field ───
        const page = await context.newPage();
        await page.goto("/certificats");

        // Select the project in the filter dropdown.
        await page.getByTestId("select-project-filter").click();
        await page
          .getByRole("option", { name: new RegExp(s.projectCode) })
          .click();

        // Open the certificat detail dialog.
        const viewBtn = page.getByTestId(`button-view-cert-${certId}`);
        await expect(viewBtn).toBeVisible({ timeout: 10_000 });
        await viewBtn.click();

        // The payment section should be present (cert is issued/sent).
        const paymentsSection = page.getByTestId("section-cert-payments");
        await expect(paymentsSection).toBeVisible({ timeout: 8_000 });

        // Click "Enregistrer un paiement" to open the form.
        const logBtn = page.getByTestId("button-log-payment");
        await expect(logBtn).toBeVisible({ timeout: 5_000 });
        await logBtn.click();

        // The form should appear with the reference pre-filled.
        const refInput = page.getByTestId("input-payment-reference");
        await expect(refInput).toBeVisible({ timeout: 5_000 });
        await expect(refInput).toHaveValue(stored!);
      } finally {
        try {
          await cleanupAcompte(db, s);
        } finally {
          await db.end();
          await context.close();
        }
      }
    },
  );
});

// ── Grouped-cert helpers (task #632) ─────────────────────────────────────────

interface SeededGrouped {
  projectId: number;
  contractorId: number;
  devisId: number;
  invAId: number;
  invBId: number;
  invANumber: string;
  invBNumber: string;
  projectCode: string;
}

async function seedGrouped(
  db: Client,
  uniq: string,
): Promise<SeededGrouped> {
  const projectCode = `TREFG-${uniq.slice(0, 6).toUpperCase()}`;

  const projRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, client_contact_email, status)
     VALUES ($1, $2, 'E2E Transfer Ref Grouped Client', $3, 'active') RETURNING id`,
    [
      `${SEED_PREFIX}grouped-project-${uniq}`,
      projectCode,
      `client-trefg-${uniq}@example.com`,
    ],
  );
  const projectId = projRes.rows[0].id;

  const ctorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, iban, bic) VALUES ($1, $2, 'BNPAFRPP') RETURNING id`,
    [`${SEED_PREFIX}grouped-contractor-${uniq}`, FAKE_IBAN],
  );
  const contractorId = ctorRes.rows[0].id;

  await db.query(
    `INSERT INTO marches
       (project_id, contractor_id, total_ht, total_ttc, retenue_garantie_percent, status)
     VALUES ($1, $2, '30000.00', '36000.00', '5.00', 'active')`,
    [projectId, contractorId],
  );

  const lotRes = await db.query<{ id: number }>(
    `INSERT INTO lots (project_id, lot_number, description_fr, description_uk)
     VALUES ($1, '01', 'Structure', 'Structural works') RETURNING id`,
    [projectId],
  );
  const lotId = lotRes.rows[0].id;

  const devisCode = `${SEED_PREFIX}GD-${uniq}`;
  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, description_uk,
        amount_ht, amount_ttc, status, sign_off_stage, lot_id)
     VALUES ($1, $2, $3, 'E2E Grouped Transfer Ref Devis', 'E2E Grouped Works',
             '20000.00', '24000.00', 'confirmed', 'client_signed_off', $4)
     RETURNING id`,
    [projectId, contractorId, devisCode, lotId],
  );
  const devisId = devisRes.rows[0].id;

  const invANumber = `GTREF-INV-A-${uniq.slice(0, 6).toUpperCase()}`;
  const invARes = await db.query<{ id: number }>(
    `INSERT INTO invoices
       (devis_id, contractor_id, project_id, invoice_number,
        amount_ht, tva_amount, amount_ttc, status)
     VALUES ($1, $2, $3, $4, '8000.00', '1600.00', '9600.00', 'pending')
     RETURNING id`,
    [devisId, contractorId, projectId, invANumber],
  );
  const invAId = invARes.rows[0].id;

  const invBNumber = `GTREF-INV-B-${uniq.slice(0, 6).toUpperCase()}`;
  const invBRes = await db.query<{ id: number }>(
    `INSERT INTO invoices
       (devis_id, contractor_id, project_id, invoice_number,
        amount_ht, tva_amount, amount_ttc, status)
     VALUES ($1, $2, $3, $4, '6000.00', '1200.00', '7200.00', 'pending')
     RETURNING id`,
    [devisId, contractorId, projectId, invBNumber],
  );
  const invBId = invBRes.rows[0].id;

  return {
    projectId,
    contractorId,
    devisId,
    invAId,
    invBId,
    invANumber,
    invBNumber,
    projectCode,
  };
}

async function cleanupGrouped(
  db: Client,
  s: SeededGrouped | null,
): Promise<void> {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    [`DELETE FROM project_communications WHERE project_id = $1`, [s.projectId]],
    [
      `DELETE FROM certificat_sources
       WHERE certificat_id IN (SELECT id FROM certificats WHERE project_id = $1)`,
      [s.projectId],
    ],
    [`DELETE FROM certificats WHERE project_id = $1`, [s.projectId]],
    [`DELETE FROM invoices WHERE id = $1`, [s.invAId]],
    [`DELETE FROM invoices WHERE id = $1`, [s.invBId]],
    [`DELETE FROM devis WHERE id = $1`, [s.devisId]],
    [`DELETE FROM lots WHERE project_id = $1`, [s.projectId]],
    [`DELETE FROM marches WHERE project_id = $1`, [s.projectId]],
    [`DELETE FROM projects WHERE id = $1`, [s.projectId]],
    [`DELETE FROM contractors WHERE id = $1`, [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn(
        "[cert-tref-grouped cleanup] swallowed:",
        (err as Error).message,
      );
    }
  }
}

// ── Invoice path (task #628) ─────────────────────────────────────────────────

test.describe("Certificat — bank-transfer reference (task #628)", () => {
  test(
    "preview PDF has transfer-ref label; seal persists paymentTransferRef; payment dialog pre-fills it",
    async ({ browser }) => {
      const databaseUrl = process.env.DATABASE_URL;
      expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

      const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const email = `${SEED_PREFIX}${uniq}@local.test`;
      const db = new Client({ connectionString: databaseUrl! });
      await db.connect();

      const context = await browser.newContext({
        viewport: { width: 1600, height: 900 },
      });
      let s: Seeded | null = null;

      try {
        await devLogin(context.request, email);
        s = await seed(db, uniq);

        // ── 1. Create a scoped certificat from the single invoice ──────────
        const createRes = await context.request.post(
          `/api/projects/${s.projectId}/certificats/from-invoices`,
          { data: { invoiceIds: [s.invoiceId] } },
        );
        expect(
          createRes.ok(),
          `from-invoices failed: HTTP ${createRes.status()} – ${await createRes.text()}`,
        ).toBe(true);

        const certRow = await db.query<{ id: number; certificate_ref: string }>(
          `SELECT id, certificate_ref FROM certificats
           WHERE project_id = $1 AND status != 'superseded'
           ORDER BY id DESC LIMIT 1`,
          [s.projectId],
        );
        expect(certRow.rows.length).toBe(1);
        const certId = certRow.rows[0].id;
        const certRef = certRow.rows[0].certificate_ref;

        // ── 2. Preview PDF — must contain the transfer-ref label ───────────
        const pdfText = await fetchPreviewPdfText(context.request, certId);

        // The label is injected by renderBankingBlock when transferRef is set.
        // Prince/DocRaptor applies text-transform:uppercase to the PDF content
        // stream (not just visually), so pdftotext returns the uppercased bytes.
        expect(pdfText.toUpperCase()).toContain("USE THIS REFERENCE FOR YOUR PAYMENT.");

        // The preview transfer ref should embed the project code, cert ref,
        // and invoice number. The invoice number suffix is stable across
        // line-wrapping; check it to confirm the value is actually rendered.
        const invSuffix = s.invoiceNumber.slice(s.invoiceNumber.indexOf("TREF-INV"));
        expect(pdfText).toContain(invSuffix);

        // ── 3. Issue (seal) the certificat via the API send endpoint ──────
        // The from-invoices endpoint creates certs as "draft"; sending calls
        // sealCertificat which persists paymentTransferRef. E2E_FAKE_GMAIL=true
        // is set in the dev workflow so no real email is sent.
        const sendRes = await context.request.post(
          `/api/projects/${s.projectId}/certificats/${certId}/send`,
        );
        expect(
          sendRes.ok(),
          `Send failed: HTTP ${sendRes.status()} – ${await sendRes.text()}`,
        ).toBe(true);

        // ── 4. Confirm paymentTransferRef is stored in the DB ─────────────
        const sealedRow = await db.query<{
          payment_transfer_ref: string | null;
          status: string;
        }>(
          `SELECT payment_transfer_ref, status FROM certificats WHERE id = $1`,
          [certId],
        );
        expect(sealedRow.rows.length).toBe(1);
        const stored = sealedRow.rows[0].payment_transfer_ref;
        expect(
          stored,
          "paymentTransferRef must be non-null after sealing",
        ).not.toBeNull();

        // Expected format: "{PROJECT CODE} {cert ref} / {invoice number}"
        const expectedRef = `${s.projectCode} ${certRef} / ${s.invoiceNumber}`;
        expect(stored).toBe(expectedRef);

        // ── 5. Open detail dialog — payment form pre-fills the ref field ───
        const page = await context.newPage();
        await page.goto("/certificats");

        // Select the project in the filter dropdown.
        await page.getByTestId("select-project-filter").click();
        await page
          .getByRole("option", { name: new RegExp(s.projectCode) })
          .click();

        // Open the certificat detail dialog.
        const viewBtn = page.getByTestId(`button-view-cert-${certId}`);
        await expect(viewBtn).toBeVisible({ timeout: 10_000 });
        await viewBtn.click();

        // The payment section should be present (cert is issued/sent, not draft).
        const paymentsSection = page.getByTestId("section-cert-payments");
        await expect(paymentsSection).toBeVisible({ timeout: 8_000 });

        // Click "Enregistrer un paiement" to open the form.
        const logBtn = page.getByTestId("button-log-payment");
        await expect(logBtn).toBeVisible({ timeout: 5_000 });
        await logBtn.click();

        // The form should appear with the reference pre-filled.
        const refInput = page.getByTestId("input-payment-reference");
        await expect(refInput).toBeVisible({ timeout: 5_000 });
        await expect(refInput).toHaveValue(stored!);
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

  test(
    "grouped cert (2 invoices): transfer ref joins both invoice numbers with ' + '; PDF renders both suffixes",
    async ({ browser }) => {
      const databaseUrl = process.env.DATABASE_URL;
      expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

      const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const email = `${SEED_PREFIX}grp-${uniq}@local.test`;
      const db = new Client({ connectionString: databaseUrl! });
      await db.connect();

      const context = await browser.newContext({
        viewport: { width: 1600, height: 900 },
      });
      let s: SeededGrouped | null = null;

      try {
        await devLogin(context.request, email);
        s = await seedGrouped(db, uniq);

        // ── 1. Create a grouped certificat from both invoices ──────────────
        const createRes = await context.request.post(
          `/api/projects/${s.projectId}/certificats/from-invoices`,
          { data: { invoiceIds: [s.invAId, s.invBId] } },
        );
        expect(
          createRes.ok(),
          `from-invoices failed: HTTP ${createRes.status()} – ${await createRes.text()}`,
        ).toBe(true);

        const certRow = await db.query<{ id: number; certificate_ref: string }>(
          `SELECT id, certificate_ref FROM certificats
           WHERE project_id = $1 AND status != 'superseded'
           ORDER BY id DESC LIMIT 1`,
          [s.projectId],
        );
        expect(certRow.rows.length).toBe(1);
        const certId = certRow.rows[0].id;
        const certRef = certRow.rows[0].certificate_ref;

        // ── 2. Preview PDF — both invoice suffixes must appear ─────────────
        // Use stable suffix fragments (short enough to avoid PDF line-wrap
        // hyphenation that would split the number across lines).
        const invASuffix = s.invANumber.slice(s.invANumber.indexOf("INV-A"));
        const invBSuffix = s.invBNumber.slice(s.invBNumber.indexOf("INV-B"));

        const pdfText = await fetchPreviewPdfText(context.request, certId);

        // Both invoice suffixes must be present in the preview PDF.
        expect(pdfText).toContain(invASuffix);
        expect(pdfText).toContain(invBSuffix);

        // The banking-block label must also be present (transfer ref is set).
        expect(pdfText.toUpperCase()).toContain(
          "USE THIS REFERENCE FOR YOUR PAYMENT.",
        );

        // ── 3. Seal (send) the certificat ─────────────────────────────────
        const sendRes = await context.request.post(
          `/api/projects/${s.projectId}/certificats/${certId}/send`,
        );
        expect(
          sendRes.ok(),
          `Send failed: HTTP ${sendRes.status()} – ${await sendRes.text()}`,
        ).toBe(true);

        // ── 4. Confirm payment_transfer_ref joins both invoice numbers ──────
        const sealedRow = await db.query<{
          payment_transfer_ref: string | null;
          status: string;
        }>(
          `SELECT payment_transfer_ref, status FROM certificats WHERE id = $1`,
          [certId],
        );
        expect(sealedRow.rows.length).toBe(1);
        const stored = sealedRow.rows[0].payment_transfer_ref;
        expect(
          stored,
          "paymentTransferRef must be non-null after sealing",
        ).not.toBeNull();

        // Expected format: "{PROJECT CODE} {cert ref} / {invA} + {invB}"
        // The service joins invoice numbers in insertion order (the order they
        // were passed to from-invoices); we pass [invAId, invBId].
        const expectedRef = `${s.projectCode} ${certRef} / ${s.invANumber} + ${s.invBNumber}`;
        expect(stored).toBe(expectedRef);
      } finally {
        try {
          await cleanupGrouped(db, s);
        } finally {
          await db.end();
          await context.close();
        }
      }
    },
  );
});
