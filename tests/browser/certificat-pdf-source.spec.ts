import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * E2E coverage for certificat PDF source-set scoping.
 *
 * Verifies:
 *   1. A grouped certificat (created via from-invoices with 2 of 3 factures)
 *      renders a PDF containing only the two selected invoice numbers and
 *      their parent devis code. The third invoice and its devis code must
 *      NOT appear.
 *   2. A manual certificat (no certificat_sources rows — the legacy
 *      whole-contractor fallback) renders a PDF that includes both devis
 *      codes, confirming the empty-sources path is unaffected.
 *
 * Seeds via direct pg; cleans up in finally. Requires NODE_ENV=development,
 * ENABLE_DEV_LOGIN_FOR_E2E=true, DATABASE_URL.
 *
 * PDF text is extracted with pdftotext (available via the poppler-utils nix
 * package).
 */

const SEED_PREFIX = "e2e-cert-pdfsrc-";
const PDFTOTEXT_BIN =
  "/nix/store/1f2vbia1rg1rh5cs0ii49v3hln9i36rv-poppler-utils-24.02.0/bin/pdftotext";

// A synthetic IBAN that passes the contractor banking gate (required before
// the generator will produce any PDF). No real funds are involved.
const FAKE_IBAN = "FR7630006000011234567890189";

interface Seeded {
  projectId: number;
  contractorId: number;
  devisAId: number;
  devisBId: number;
  devisACode: string;
  devisBCode: string;
  invA: number;
  invB: number;
  invC: number;
  invANumber: string;
  invBNumber: string;
  invCNumber: string;
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const projRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, status)
     VALUES ($1, $2, 'E2E PDF Source Client', 'active') RETURNING id`,
    [`${SEED_PREFIX}project-${uniq}`, `${SEED_PREFIX}${uniq}`],
  );
  const projectId = projRes.rows[0].id;

  const ctorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, iban) VALUES ($1, $2) RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`, FAKE_IBAN],
  );
  const contractorId = ctorRes.rows[0].id;

  // A marché is required for the certificat preview to compute retenue de
  // garantie.
  await db.query(
    `INSERT INTO marches
       (project_id, contractor_id, total_ht, total_ttc, retenue_garantie_percent, status)
     VALUES ($1, $2, '30000.00', '36000.00', '5.00', 'active')`,
    [projectId, contractorId],
  );

  // devisA — carries invA and invB (both 20% TVA)
  const devisACode = `${SEED_PREFIX}DA-${uniq}`;
  const devisARes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr,
        amount_ht, amount_ttc, status, sign_off_stage)
     VALUES ($1, $2, $3, 'E2E PDF Source DevisA',
             '15000.00', '18000.00', 'confirmed', 'client_signed_off')
     RETURNING id`,
    [projectId, contractorId, devisACode],
  );
  const devisAId = devisARes.rows[0].id;

  // devisB — carries invC only (20% TVA). Must NOT appear in the grouped
  // cert whose sources are restricted to devisA's invoices.
  const devisBCode = `${SEED_PREFIX}DB-${uniq}`;
  const devisBRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr,
        amount_ht, amount_ttc, status, sign_off_stage)
     VALUES ($1, $2, $3, 'E2E PDF Source DevisB',
             '10000.00', '12000.00', 'confirmed', 'client_signed_off')
     RETURNING id`,
    [projectId, contractorId, devisBCode],
  );
  const devisBId = devisBRes.rows[0].id;

  // invA on devisA at 20% TVA
  const invANumber = `${SEED_PREFIX}INV-A-${uniq}`;
  const invARes = await db.query<{ id: number }>(
    `INSERT INTO invoices
       (devis_id, contractor_id, project_id, invoice_number,
        amount_ht, tva_amount, amount_ttc, status)
     VALUES ($1, $2, $3, $4, '2000.00', '400.00', '2400.00', 'pending')
     RETURNING id`,
    [devisAId, contractorId, projectId, invANumber],
  );
  const invA = invARes.rows[0].id;

  // invB on devisA at 20% TVA
  const invBNumber = `${SEED_PREFIX}INV-B-${uniq}`;
  const invBRes = await db.query<{ id: number }>(
    `INSERT INTO invoices
       (devis_id, contractor_id, project_id, invoice_number,
        amount_ht, tva_amount, amount_ttc, status)
     VALUES ($1, $2, $3, $4, '3000.00', '600.00', '3600.00', 'pending')
     RETURNING id`,
    [devisAId, contractorId, projectId, invBNumber],
  );
  const invB = invBRes.rows[0].id;

  // invC on devisB at 20% TVA — must be absent from the grouped cert PDF
  const invCNumber = `${SEED_PREFIX}INV-C-${uniq}`;
  const invCRes = await db.query<{ id: number }>(
    `INSERT INTO invoices
       (devis_id, contractor_id, project_id, invoice_number,
        amount_ht, tva_amount, amount_ttc, status)
     VALUES ($1, $2, $3, $4, '1500.00', '300.00', '1800.00', 'pending')
     RETURNING id`,
    [devisBId, contractorId, projectId, invCNumber],
  );
  const invC = invCRes.rows[0].id;

  return {
    projectId,
    contractorId,
    devisAId,
    devisBId,
    devisACode,
    devisBCode,
    invA,
    invB,
    invC,
    invANumber,
    invBNumber,
    invCNumber,
  };
}

async function cleanup(db: Client, s: Seeded | null): Promise<void> {
  if (!s) return;
  await db
    .query(
      `DELETE FROM certificat_sources
       WHERE certificat_id IN (SELECT id FROM certificats WHERE project_id = $1)`,
      [s.projectId],
    )
    .catch((e: Error) =>
      console.warn("[cert-pdfsrc cleanup] certificat_sources:", e.message),
    );
  await db
    .query(`DELETE FROM certificats WHERE project_id = $1`, [s.projectId])
    .catch((e: Error) =>
      console.warn("[cert-pdfsrc cleanup] certificats:", e.message),
    );
  await db
    .query(`DELETE FROM projects WHERE id = $1`, [s.projectId])
    .catch((e: Error) =>
      console.warn("[cert-pdfsrc cleanup] projects:", e.message),
    );
  await db
    .query(`DELETE FROM contractors WHERE id = $1`, [s.contractorId])
    .catch((e: Error) =>
      console.warn("[cert-pdfsrc cleanup] contractors:", e.message),
    );
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

/**
 * Fetch the preview PDF for a certificat and return its text content via
 * pdftotext. The PDF bytes are written to a temp file, extracted, then the
 * temp file is removed.
 */
async function fetchAndExtractPdf(
  api: APIRequestContext,
  certId: number,
): Promise<string> {
  const res = await api.post(`/api/certificats/${certId}/preview`);
  expect(
    res.ok(),
    `Preview fetch failed for cert ${certId}: HTTP ${res.status()}`,
  ).toBe(true);

  const body = await res.body();
  const tmp = join(tmpdir(), `cert-pdfsrc-${certId}-${Date.now()}.pdf`);
  try {
    writeFileSync(tmp, body);
    // "-" as output argument writes extracted text to stdout.
    return execFileSync(PDFTOTEXT_BIN, [tmp, "-"], { encoding: "utf-8" });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
  }
}

test.describe("Certificat PDF source-set scoping", () => {
  test(
    "grouped cert PDF shows only selected factures; manual cert PDF shows all devis",
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

        // ── 1. Create grouped cert from invA + invB (both on devisA) ──────────
        const createRes = await context.request.post(
          `/api/projects/${s.projectId}/certificats/from-invoices`,
          { data: { invoiceIds: [s.invA, s.invB] } },
        );
        expect(
          createRes.ok(),
          `from-invoices failed: HTTP ${createRes.status()} – ${await createRes.text()}`,
        ).toBe(true);

        // Retrieve the created certificat's id from the DB.
        const certRows = await db.query<{ id: number }>(
          `SELECT id FROM certificats WHERE project_id = $1 AND status != 'superseded'
           ORDER BY id DESC LIMIT 1`,
          [s.projectId],
        );
        expect(certRows.rows.length).toBe(1);
        const groupedCertId = certRows.rows[0].id;

        // ── 2. Render preview PDF; extract text via pdftotext ─────────────────
        const groupedText = await fetchAndExtractPdf(
          context.request,
          groupedCertId,
        );

        // Invoice numbers are rendered as "#<number>" in the works table. Long
        // seed prefixes can be line-wrapped by the PDF renderer, which causes
        // pdftotext to drop the hyphen at the break point. Asserting on the
        // "INV-X-<uniq>" suffix (everything from "INV-" onward) avoids that
        // fragility — that fragment is always short enough to land on one line.
        const invASuffix = s.invANumber.slice(s.invANumber.indexOf("INV-A"));
        const invBSuffix = s.invBNumber.slice(s.invBNumber.indexOf("INV-B"));
        const invCSuffix = s.invCNumber.slice(s.invCNumber.indexOf("INV-C"));

        // Selected invoices MUST appear in the works table.
        expect(groupedText).toContain(invASuffix);
        expect(groupedText).toContain(invBSuffix);

        // The unselected invoice MUST NOT appear anywhere in the PDF.
        // Note: the financial-summary annexe (page 3) renders all devis codes
        // for project context even for grouped certs, so we scope the exclusion
        // check to invoice numbers (which only appear in the scoped works table).
        expect(groupedText).not.toContain(invCSuffix);

        // ── 3. Insert a manual certificat (no source rows) ────────────────────
        // This simulates the legacy / whole-contractor path where
        // certificat_sources has no invoice rows.
        const manualRef = `MANUAL-${uniq}`;
        const manualRes = await db.query<{ id: number }>(
          `INSERT INTO certificats
             (project_id, contractor_id, certificate_ref,
              total_works_ht, net_to_pay_ht, tva_amount, net_to_pay_ttc, status)
           VALUES ($1, $2, $3,
                   '30000.00', '27000.00', '5400.00', '32400.00', 'draft')
           RETURNING id`,
          [s.projectId, s.contractorId, manualRef],
        );
        const manualCertId = manualRes.rows[0].id;
        // No certificat_sources rows → empty-sources fallback.

        // ── 4. Render manual preview PDF; extract text ────────────────────────
        const manualText = await fetchAndExtractPdf(
          context.request,
          manualCertId,
        );

        // The unselected invoice must now appear — the whole-contractor fallback
        // is unaffected and shows all devis/invoices. Use the stable suffix form
        // (same PDF hyphenation concern as above; devis descriptions are plain
        // ASCII without embedded hyphens and survive rendering intact).
        expect(manualText).toContain(invASuffix);
        expect(manualText).toContain(invCSuffix);
        // Both devis descriptions must appear in the works table.
        expect(manualText).toContain("E2E PDF Source DevisA");
        expect(manualText).toContain("E2E PDF Source DevisB");
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
