import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * Task #458 — browser coverage for the read-only Document Chain page
 * (/devis/:id/document-chain, Task #451).
 *
 * Seeds a Mode B devis (no source PDF) with:
 *   - no marché,
 *   - situation n°1 linked to an invoice, situation n°2 unlinked,
 *   - invoice F1 certified by a SEALED certificat (pinned PDF in object
 *     storage), invoice F2 with no PDF and no certificat,
 *   - a second DRAFT certificat (no pinned PDF) sourcing situation n°1.
 *
 * Asserts:
 *   1. The Situations step renders (Mode B path) with both rows.
 *   2. Missing-evidence flags: devis "Source PDF missing", situation n°2
 *      "No facture linked", invoice F2 "Source PDF missing" + "Not
 *      certified" (and F1 shows neither).
 *   3. Sealed certificat shows the green Sealed badge + a working pinned-PDF
 *      download (endpoint returns real %PDF- bytes).
 *   4. Draft certificat shows the amber draft badge, NO download button, and
 *      the pinned-PDF endpoint 404s.
 *
 * Requires NODE_ENV=development, ENABLE_DEV_LOGIN_FOR_E2E=true and
 * DATABASE_URL (run against a self-booted side server per the usual quirks).
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`).toBe(true);
}

async function postOk<T = unknown>(api: APIRequestContext, url: string, body: unknown): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `${url} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`).toBe(true);
  return (await res.json()) as T;
}

/** Minimal valid single-page PDF used as the pinned certificat bytes. */
const TINY_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
trailer<</Size 4/Root 1 0 R>>
startxref
164
%%EOF`,
  "latin1",
);

function makeCertBody(contractorId: number) {
  return {
    contractorId,
    totalWorksHt: "4000.00",
    pvMvAdjustment: "0.00",
    previousPayments: "0.00",
    retenueGarantie: "0.00",
    netToPayHt: "4000.00",
    tvaAmount: "800.00",
    netToPayTtc: "4800.00",
    status: "draft",
  };
}

test.describe("Document Chain page (Task #458)", () => {
  test("flags missing evidence and serves the pinned certificat PDF", async ({ browser }) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

    let projectId: number | null = null;
    let contractorId: number | null = null;
    let devisId: number | null = null;
    const invoiceIds: number[] = [];
    const situationIds: number[] = [];
    const certificatIds: number[] = [];
    let docId: number | null = null;

    try {
      const api = context.request;
      await devLogin(api, `e2e-doc-chain-${uniq}@local.test`);

      // --- Seed: project + contractor + Mode B devis (no PDFs, no marché) ---
      const project = await postOk<{ id: number }>(api, "/api/projects", {
        name: `DocChain ${uniq}`,
        code: `DC-${uniq}`,
        clientName: "Doc Chain Client",
      });
      projectId = project.id;
      const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
        name: `DocChain Co ${uniq}`,
      });
      contractorId = contractor.id;
      const devis = await postOk<{ id: number }>(api, `/api/projects/${projectId}/devis`, {
        contractorId,
        devisCode: `DC-D-${uniq}`,
        descriptionFr: `Second œuvre ${uniq}`,
        amountHt: "10000.00",
        amountTtc: "12000.00",
        invoicingMode: "mode_b",
      });
      devisId = devis.id;

      // --- Two invoices: F1 (will be certified), F2 (no PDF, uncertified) ---
      const inv1 = await postOk<{ id: number }>(api, `/api/devis/${devisId}/invoices`, {
        contractorId,
        projectId,
        invoiceNumber: `DC-F1-${uniq}`,
        amountHt: "4000.00",
        tvaAmount: "800.00",
        amountTtc: "4800.00",
        status: "pending",
      });
      invoiceIds.push(inv1.id);
      const inv2 = await postOk<{ id: number }>(api, `/api/devis/${devisId}/invoices`, {
        contractorId,
        projectId,
        invoiceNumber: `DC-F2-${uniq}`,
        amountHt: "2000.00",
        tvaAmount: "400.00",
        amountTtc: "2400.00",
        status: "pending",
      });
      invoiceIds.push(inv2.id);

      // --- Two situations via SQL: n°1 linked to F1, n°2 unlinked ---
      const sit1 = await db.query(
        `INSERT INTO situations (devis_id, invoice_id, situation_number, cumulative_ht, previous_ht, net_ht, net_to_pay_ht, tva_amount, net_to_pay_ttc, status)
         VALUES ($1, $2, 1, '4000.00', '0.00', '4000.00', '4000.00', '800.00', '4800.00', 'confirmed') RETURNING id`,
        [devisId, inv1.id],
      );
      const sit1Id: number = sit1.rows[0].id;
      situationIds.push(sit1Id);
      const sit2 = await db.query(
        `INSERT INTO situations (devis_id, situation_number, cumulative_ht, previous_ht, net_ht, net_to_pay_ht, tva_amount, net_to_pay_ttc, status)
         VALUES ($1, 2, '6000.00', '4000.00', '2000.00', '2000.00', '400.00', '2400.00', 'draft') RETURNING id`,
        [devisId],
      );
      const sit2Id: number = sit2.rows[0].id;
      situationIds.push(sit2Id);

      // --- Certificats: one SEALED (pinned PDF), one DRAFT ---
      const sealedCert = await postOk<{ id: number }>(api, `/api/projects/${projectId}/certificats`, makeCertBody(contractorId));
      certificatIds.push(sealedCert.id);
      const draftCert = await postOk<{ id: number }>(api, `/api/projects/${projectId}/certificats`, makeCertBody(contractorId));
      certificatIds.push(draftCert.id);

      // Store a real tiny PDF in object storage via the documents upload and
      // pin the sealed certificat at that storage key.
      const uploadRes = await api.post(`/api/projects/${projectId}/documents/upload`, {
        multipart: {
          file: { name: `dc-cert-${uniq}.pdf`, mimeType: "application/pdf", buffer: TINY_PDF },
        },
      });
      expect(uploadRes.ok(), `doc upload failed: ${uploadRes.status()}`).toBe(true);
      const doc = (await uploadRes.json()) as { id: number; storageKey: string };
      docId = doc.id;
      await db.query(
        "UPDATE certificats SET pdf_storage_key = $1, pdf_file_name = $2, issued_at = NOW(), status = 'sent' WHERE id = $3",
        [doc.storageKey, `Certificat_DC_${uniq}.pdf`, sealedCert.id],
      );

      // FK-grounded linkage: sealed cert certifies invoice F1; draft cert
      // sources situation n°1. Invoice F2 stays uncertified.
      await db.query(
        "INSERT INTO certificat_sources (certificat_id, invoice_id) VALUES ($1, $2)",
        [sealedCert.id, inv1.id],
      );
      await db.query(
        "INSERT INTO certificat_sources (certificat_id, situation_id) VALUES ($1, $2)",
        [draftCert.id, sit1Id],
      );

      // ---------- Walk the page ----------
      const page = await context.newPage();
      await page.goto(`/devis/${devisId}/document-chain`);

      // Header + steps render; Mode B path shows the Situations step.
      await expect(page.getByTestId("chain-step-devis")).toBeVisible();
      await expect(page.getByTestId("text-no-marche")).toBeVisible();
      await expect(page.getByTestId("chain-step-situations")).toBeVisible();
      await expect(page.getByTestId(`chain-situation-${sit1Id}`)).toBeVisible();
      await expect(page.getByTestId(`chain-situation-${sit2Id}`)).toBeVisible();

      // --- Missing-evidence flags ---
      // Devis has no source PDF.
      await expect(page.getByTestId("flag-devis-source-missing")).toBeVisible();
      await expect(page.getByTestId("button-devis-source-pdf")).toHaveCount(0);
      // Situation n°2 has no facture; n°1 is linked so no flag.
      await expect(page.getByTestId(`flag-situation-${sit2Id}-no-invoice`)).toBeVisible();
      await expect(page.getByTestId(`flag-situation-${sit1Id}-no-invoice`)).toHaveCount(0);
      // Invoice F2: source PDF missing + not certified.
      await expect(page.getByTestId(`flag-invoice-${inv2.id}-pdf-missing`)).toBeVisible();
      await expect(page.getByTestId(`flag-invoice-${inv2.id}-uncertified`)).toBeVisible();
      await expect(page.getByTestId(`flag-invoice-${inv2.id}-uncertified`)).toContainText("Not certified");
      // Invoice F1 is certified (no uncertified flag).
      await expect(page.getByTestId(`chain-invoice-${inv1.id}`)).toBeVisible();
      await expect(page.getByTestId(`flag-invoice-${inv1.id}-uncertified`)).toHaveCount(0);

      // --- Sealed certificat: green badge + working pinned-PDF download ---
      const sealedBadge = page.getByTestId(`badge-certificat-${sealedCert.id}-sealed`);
      await expect(sealedBadge).toBeVisible();
      await expect(sealedBadge).toContainText("Sealed");
      const dlButton = page.getByTestId(`button-certificat-${sealedCert.id}-pdf`);
      await expect(dlButton).toBeVisible();
      const pdfRes = await api.get(`/api/certificats/${sealedCert.id}/pdf`);
      expect(pdfRes.ok(), `pinned PDF fetch failed: ${pdfRes.status()}`).toBe(true);
      expect(pdfRes.headers()["content-type"]).toContain("application/pdf");
      const pdfBuf = Buffer.from(await pdfRes.body());
      expect(pdfBuf.subarray(0, 5).toString()).toBe("%PDF-");

      // --- Draft certificat: amber badge, no download, endpoint 404s ---
      const draftBadge = page.getByTestId(`badge-certificat-${draftCert.id}-draft`);
      await expect(draftBadge).toBeVisible();
      await expect(draftBadge).toContainText("Draft");
      await expect(page.getByTestId(`button-certificat-${draftCert.id}-pdf`)).toHaveCount(0);
      const draftPdfRes = await api.get(`/api/certificats/${draftCert.id}/pdf`);
      expect(draftPdfRes.status()).toBe(404);
    } finally {
      try {
        if (certificatIds.length) await db.query("DELETE FROM certificats WHERE id = ANY($1::int[])", [certificatIds]);
        if (situationIds.length) await db.query("DELETE FROM situations WHERE id = ANY($1::int[])", [situationIds]);
        if (invoiceIds.length) await db.query("DELETE FROM invoices WHERE id = ANY($1::int[])", [invoiceIds]);
        if (docId) await db.query("DELETE FROM project_documents WHERE id = $1", [docId]);
        if (devisId) {
          await db.query("DELETE FROM devis_line_items WHERE devis_id = $1", [devisId]);
          await db.query("DELETE FROM devis WHERE id = $1", [devisId]);
        }
        if (projectId) await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
        if (contractorId) await db.query("DELETE FROM contractors WHERE id = $1", [contractorId]);
      } catch (err) {
        console.warn("[doc-chain cleanup] swallowed:", (err as Error).message);
      }
      await db.end();
      await context.close();
    }
  });
});
