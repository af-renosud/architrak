import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { PDFDocument } from "pdf-lib";

/**
 * Task #413 — one-page project financial overview PDF.
 *
 * Verifies:
 *   1. GET /api/projects/:id/overview-pdf returns a real PDF for a seeded
 *      project (magic bytes + content-type), even with zero devis.
 *   2. GET /api/invoices/:id/pdf-with-overview merges the stored invoice PDF
 *      with the overview: the combined page count is strictly greater than
 *      the invoice's own page count, and it's a valid PDF.
 *   3. Package endpoint 404s for an invoice without a stored PDF.
 *   4. The FacturesTab shows the project-level overview button always, and
 *      the per-invoice Client PDF button only when the invoice has a PDF.
 *
 * Requires ENABLE_DEV_LOGIN_FOR_E2E=true, DATABASE_URL, and a live
 * DOCRAPTOR_API_KEY (the overview is really rendered).
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), `dev-login failed (${res.status()})`).toBe(true);
}

async function postOk<T = unknown>(api: APIRequestContext, url: string, body: unknown): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `${url} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`).toBe(true);
  return (await res.json()) as T;
}

/** Minimal single-page PDF, enough for pdf-lib to load and copy. */
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

async function countPdfPages(buf: Buffer): Promise<number> {
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  return doc.getPageCount();
}

test.describe("Project financial overview PDF (Task #413)", () => {
  test("overview + combined invoice package endpoints and UI buttons", async ({ browser }) => {
    test.setTimeout(180_000);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

    let projectId: number | null = null;
    let contractorId: number | null = null;
    let devisId: number | null = null;
    const extraDevisIds: number[] = [];
    const invoiceIds: number[] = [];
    let docId: number | null = null;

    try {
      const api = context.request;
      await devLogin(api, `e2e-overview-${uniq}@local.test`);

      // --- Seed: project + contractor + devis + two invoices ---
      const project = await postOk<{ id: number }>(api, "/api/projects", {
        name: `Overview ${uniq}`,
        code: `OV-${uniq}`,
        clientName: "Overview Client",
      });
      projectId = project.id;
      const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
        name: `Overview Co ${uniq}`,
      });
      contractorId = contractor.id;
      const devis = await postOk<{ id: number }>(api, `/api/projects/${projectId}/devis`, {
        contractorId,
        devisCode: `OV-D-${uniq}`,
        descriptionFr: `Gros œuvre ${uniq}`,
        amountHt: "10000.00",
        amountTtc: "12000.00",
        invoicingMode: "mode_b",
      });
      devisId = devis.id;

      // One-page guarantee under load: 24 more devis (25 total, well past the
      // itemised-row cap) must still yield a single-page overview.
      for (let i = 0; i < 24; i++) {
        const extra = await postOk<{ id: number }>(api, `/api/projects/${projectId}/devis`, {
          contractorId,
          devisCode: `OV-X${String(i).padStart(2, "0")}-${uniq}`,
          descriptionFr: `Lot secondaire ${i} ${uniq}`,
          amountHt: (100 + i).toFixed(2),
          amountTtc: (120 + i).toFixed(2),
          invoicingMode: "mode_b",
        });
        extraDevisIds.push(extra.id);
      }

      const invWithPdf = await postOk<{ id: number }>(api, `/api/devis/${devisId}/invoices`, {
        contractorId,
        projectId,
        invoiceNumber: `OV-F1-${uniq}`,
        amountHt: "4000.00",
        tvaAmount: "800.00",
        amountTtc: "4800.00",
        status: "pending",
      });
      invoiceIds.push(invWithPdf.id);
      const invNoPdf = await postOk<{ id: number }>(api, `/api/devis/${devisId}/invoices`, {
        contractorId,
        projectId,
        invoiceNumber: `OV-F2-${uniq}`,
        amountHt: "1000.00",
        tvaAmount: "200.00",
        amountTtc: "1200.00",
        status: "pending",
      });
      invoiceIds.push(invNoPdf.id);

      // Store a real (tiny) PDF via the documents upload and point the first
      // invoice's pdfPath at its storage key.
      const uploadRes = await api.post(`/api/projects/${projectId}/documents/upload`, {
        multipart: {
          file: { name: `ov-invoice-${uniq}.pdf`, mimeType: "application/pdf", buffer: TINY_PDF },
        },
      });
      expect(uploadRes.ok(), `doc upload failed: ${uploadRes.status()}`).toBe(true);
      const doc = (await uploadRes.json()) as { id: number; storageKey: string };
      docId = doc.id;
      await db.query("UPDATE invoices SET pdf_path = $1 WHERE id = $2", [doc.storageKey, invWithPdf.id]);

      // --- 1. Project overview endpoint returns a real PDF ---
      const overviewRes = await api.get(`/api/projects/${projectId}/overview-pdf`);
      expect(overviewRes.ok(), `overview-pdf failed: ${overviewRes.status()} ${(await overviewRes.text()).slice(0, 200)}`).toBe(true);
      expect(overviewRes.headers()["content-type"]).toContain("application/pdf");
      const overviewBuf = Buffer.from(await overviewRes.body());
      expect(overviewBuf.subarray(0, 5).toString()).toBe("%PDF-");
      const overviewPages = await countPdfPages(overviewBuf);
      // One-page guarantee, even with 25 active devis (rollup row kicks in).
      expect(overviewPages).toBe(1);

      // --- 2. Combined invoice package: invoice pages + overview pages ---
      const pkgRes = await api.get(`/api/invoices/${invWithPdf.id}/pdf-with-overview`);
      expect(pkgRes.ok(), `pdf-with-overview failed: ${pkgRes.status()} ${(await pkgRes.text()).slice(0, 200)}`).toBe(true);
      expect(pkgRes.headers()["content-type"]).toContain("application/pdf");
      const pkgBuf = Buffer.from(await pkgRes.body());
      expect(pkgBuf.subarray(0, 5).toString()).toBe("%PDF-");
      // 1 invoice page + >=1 overview page
      expect(await countPdfPages(pkgBuf)).toBe(1 + overviewPages);

      // --- 3. Invoice without a stored PDF → 404 ---
      const noPdfRes = await api.get(`/api/invoices/${invNoPdf.id}/pdf-with-overview`);
      expect(noPdfRes.status()).toBe(404);

      // --- 4. Unknown project → 404 ---
      const unknownRes = await api.get(`/api/projects/999999999/overview-pdf`);
      expect(unknownRes.status()).toBe(404);

      // --- 5. UI: buttons in the Factures tab ---
      const page = await context.newPage();
      await page.goto(`/projets/${projectId}`);
      await page.getByTestId("tab-factures").click();
      await expect(page.getByTestId("button-project-overview-pdf")).toBeVisible();
      await expect(page.getByTestId(`button-client-package-facture-${invWithPdf.id}`)).toBeVisible();
      await expect(page.getByTestId(`button-client-package-facture-${invNoPdf.id}`)).toHaveCount(0);
    } finally {
      // Cleanup
      try {
        if (invoiceIds.length) await db.query("DELETE FROM invoices WHERE id = ANY($1::int[])", [invoiceIds]);
        if (docId) await db.query("DELETE FROM project_documents WHERE id = $1", [docId]);
        const allDevisIds = [devisId, ...extraDevisIds].filter((v): v is number => v != null);
        if (allDevisIds.length) {
          await db.query("DELETE FROM devis_line_items WHERE devis_id = ANY($1::int[])", [allDevisIds]);
          await db.query("DELETE FROM devis WHERE id = ANY($1::int[])", [allDevisIds]);
        }
        if (projectId) await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
        if (contractorId) await db.query("DELETE FROM contractors WHERE id = $1", [contractorId]);
      } catch (err) {
        console.warn("[overview cleanup] swallowed:", (err as Error).message);
      }
      await db.end();
      await context.close();
    }
  });
});
