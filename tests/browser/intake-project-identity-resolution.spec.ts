import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

const PREFIX = "e2e-intake-project-resolution-";

async function devLogin(api: APIRequestContext, email: string) {
  const response = await api.post("/api/auth/dev-login", { data: { email } });
  expect(response.ok(), `dev-login failed (${response.status()})`).toBe(true);
}

function withLuhnCheckDigit(prefix: string): string {
  for (let check = 0; check <= 9; check += 1) {
    const candidate = `${prefix}${check}`;
    const sum = candidate
      .split("")
      .reverse()
      .reduce((total, digit, index) => {
        let value = Number(digit);
        if (index % 2 === 1) {
          value *= 2;
          if (value > 9) value -= 9;
        }
        return total + value;
      }, 0);
    if (sum % 10 === 0) return candidate;
  }
  throw new Error("Could not generate a Luhn-valid SIRET");
}

test("human project confirmation unlocks deposit review and routes the invoice exactly once", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();

  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const email = `${PREFIX}${uniq}@local.test`;
  const devisCode = `D-${uniq.slice(-8).toUpperCase()}`;
  const invoiceNumber = `FR-${uniq.slice(-10).toUpperCase()}`;
  const siret = withLuhnCheckDigit(`${Date.now()}`.slice(-13));
  let projectId: number | null = null;
  let contractorId: number | null = null;
  let devisId: number | null = null;
  let certificatId: number | null = null;
  let anchorDocId: number | null = null;
  let docId: number | null = null;

  try {
    await devLogin(request, email);
    const projectResponse = await request.post("/api/projects", {
      data: {
        name: `TRÜTKEN (VERFEUIL) ${uniq}`,
        code: `T688-${uniq}`.slice(0, 20),
        clientName: "Heinz Hermann Trütken",
      },
    });
    expect(projectResponse.ok()).toBe(true);
    projectId = ((await projectResponse.json()) as { id: number }).id;

    const contractorResult = await db.query<{ id: number }>(
      "INSERT INTO contractors (name, siret) VALUES ($1, $2) RETURNING id",
      [`${PREFIX}contractor-${uniq}`, siret],
    );
    contractorId = contractorResult.rows[0].id;
    await db.query(
      `INSERT INTO marches (project_id, contractor_id, total_ht, total_ttc, retenue_garantie_percent)
       VALUES ($1, $2, '10000.00', '12000.00', '5.00')`,
      [projectId, contractorId],
    );
    const devisResult = await db.query<{ id: number }>(
      `INSERT INTO devis
         (project_id, contractor_id, devis_code, devis_number, description_fr,
          amount_ht, amount_ttc, acompte_required, acompte_amount_ht, acompte_state,
          sign_off_stage, accounting_state)
       VALUES ($1, $2, $3, $3, 'Opening deposit test', '10000.00', '12000.00',
               true, '1240.00', 'pending', 'client_signed_off', 'active')
       RETURNING id`,
      [projectId, contractorId, devisCode],
    );
    devisId = devisResult.rows[0].id;

    const certificatResponse = await request.post(`/api/devis/${devisId}/acompte/generate-certificat`);
    expect(certificatResponse.status()).toBe(201);
    certificatId = ((await certificatResponse.json()) as { id: number }).id;
    await db.query("UPDATE certificats SET status = 'paid' WHERE id = $1", [certificatId]);

    const minimalPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj\n"
      + "2 0 obj<</Type /Pages /Kids [3 0 R] /Count 1>>endobj\n"
      + "3 0 obj<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>endobj\n"
      + "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n"
      + "0000000058 00000 n \n0000000115 00000 n \n"
      + "trailer<</Size 4 /Root 1 0 R>>\nstartxref\n190\n%%EOF",
    );
    const uploadResponse = await request.post(`/api/projects/${projectId}/intake/upload`, {
      multipart: {
        file: {
          name: `${PREFIX}anchor-${uniq}.pdf`,
          mimeType: "application/pdf",
          buffer: minimalPdf,
        },
      },
    });
    expect(uploadResponse.ok()).toBe(true);
    const uploaded = (await uploadResponse.json()) as { id: number; storageKey: string };
    anchorDocId = uploaded.id;
    await db.query("DELETE FROM project_intake_documents WHERE id = $1", [anchorDocId]);
    anchorDocId = null;

    const extracted = {
      preParsedFromEmail: true,
      documentType: "invoice",
      invoiceNumber,
      reference: invoiceNumber,
      devisNumber: devisCode,
      contractorName: `${PREFIX}contractor-${uniq}`,
      siret,
      amountHt: 2075,
      amountTtc: 2490,
      netAPayer: 1002,
      date: "2026-08-20",
      projectName: "VERFEUIL Projet Heinz Hermann Trütken - 406 chemin de la grange",
      acomptePaidAmountTtc: 1488,
      acomptePaidEvidenceText: "Acompte versé 1 488,00 €",
    };
    const docResult = await db.query<{ id: number }>(
      `INSERT INTO project_intake_documents
         (project_id, file_name, storage_key, mime_type, source,
          analysis_state, routing_state, extracted_data, uploaded_by)
       VALUES ($1, 'FR25.26-0144.pdf', $2, 'application/pdf', 'email',
               'analyzed', 'parked', $3::jsonb, 'e2e')
       RETURNING id`,
      [projectId, uploaded.storageKey, JSON.stringify(extracted)],
    );
    docId = docResult.rows[0].id;
    const reanalyzeResponse = await request.post(`/api/intake-documents/${docId}/reanalyze`);
    expect(reanalyzeResponse.ok()).toBe(true);
    await expect.poll(async () => {
      const result = await db.query<{ analysis_state: string; routing_state: string }>(
        "SELECT analysis_state, routing_state FROM project_intake_documents WHERE id = $1",
        [docId],
      );
      return `${result.rows[0]?.analysis_state}/${result.rows[0]?.routing_state}`;
    }, { timeout: 30_000 }).toBe("analyzed/parked");

    await devLogin(page.request, email);
    await page.goto(`/projets/${projectId}`);
    await page.getByTestId("tab-intake").click();
    await expect(page.getByTestId(`button-confirm-intake-project-${docId}`)).toBeVisible();
    await page.getByTestId(`button-confirm-intake-project-${docId}`).click();
    await expect(page.getByTestId("text-intake-project-label")).toContainText("VERFEUIL Projet");
    await page.getByTestId("button-confirm-intake-project-submit").click();

    await expect.poll(async () => {
      const result = await db.query<{
        analysis_state: string;
        routing_state: string;
        notes: string | null;
        has_resolution: boolean;
      }>(
        `SELECT analysis_state, routing_state, notes,
                (extracted_data ? 'openingAcompteResolution') AS has_resolution
         FROM project_intake_documents WHERE id = $1`,
        [docId],
      );
      const row = result.rows[0];
      return row?.has_resolution
        ? "deposit-ready"
        : `${row?.analysis_state}/${row?.routing_state}: ${row?.notes ?? ""}`;
    }, { timeout: 30_000 }).toBe("deposit-ready");
    const depositButton = page.getByTestId(`button-resolve-opening-acompte-${docId}`);
    await expect(depositButton).toBeVisible({ timeout: 30_000 });
    await depositButton.click();
    await page.getByTestId("input-opening-acompte-reference").fill(`VIR-${uniq}`);
    await page.getByTestId("checkbox-confirm-opening-acompte").click();
    await page.getByTestId("button-submit-opening-acompte").click();

    await expect(page.getByTestId(`button-open-draft-${docId}`)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => {
      const result = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM invoices WHERE devis_id = $1 AND invoice_number = $2",
        [devisId, invoiceNumber],
      );
      return Number(result.rows[0].count);
    }).toBe(1);
    const state = await db.query<{ acompte_state: string }>(
      "SELECT acompte_state FROM devis WHERE id = $1",
      [devisId],
    );
    expect(state.rows[0].acompte_state).toBe("paid");
    const evidence = await db.query<{ certificat_id: number; count: string }>(
      `SELECT min(certificat_id)::integer AS certificat_id, count(*)::text AS count
       FROM acompte_no_invoice_payments WHERE devis_id = $1`,
      [devisId],
    );
    expect(Number(evidence.rows[0].count)).toBe(1);
    expect(evidence.rows[0].certificat_id).toBe(certificatId);
    const resolutions = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM intake_project_identity_resolutions WHERE intake_document_id = $1",
      [docId],
    );
    expect(Number(resolutions.rows[0].count)).toBe(1);
  } finally {
    try {
      if (devisId) {
        await db.query("BEGIN");
        await db.query("SELECT set_config('app.allow_acompte_audit_delete', 'true', true)");
        await db.query("DELETE FROM acompte_no_invoice_payments WHERE devis_id = $1", [devisId]);
        await db.query("COMMIT");
      }
      if (docId) {
        await db.query("BEGIN");
        await db.query("SELECT set_config('app.allow_intake_project_identity_resolution_delete', 'true', true)");
        await db.query("DELETE FROM intake_project_identity_resolutions WHERE intake_document_id = $1", [docId]);
        await db.query("COMMIT");
      }
      if (projectId) {
        await db.query("DELETE FROM invoices WHERE project_id = $1", [projectId]);
        await db.query("DELETE FROM project_documents WHERE project_id = $1", [projectId]);
        await db.query("DELETE FROM certificats WHERE project_id = $1", [projectId]);
      }
      if (docId) await db.query("DELETE FROM project_intake_documents WHERE id = $1", [docId]);
      if (anchorDocId) await db.query("DELETE FROM project_intake_documents WHERE id = $1", [anchorDocId]);
      if (devisId) await db.query("DELETE FROM devis WHERE id = $1", [devisId]);
      if (projectId) await db.query("DELETE FROM marches WHERE project_id = $1", [projectId]);
      if (contractorId) await db.query("DELETE FROM contractors WHERE id = $1", [contractorId]);
      if (projectId) await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
    } finally {
      await db.end();
    }
  }
});