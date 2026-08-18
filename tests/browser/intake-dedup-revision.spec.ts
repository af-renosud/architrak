import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * Integration + browser coverage for the line-aware intake dedup path
 * (Task #593 / Task #598).
 *
 * Task #593 made the dedup pass line-item-aware: a document with the same
 * devis number and same HT total but DIFFERENT line items must park for human
 * review instead of being silently flagged as a duplicate. This spec drives
 * the full intake pipeline end-to-end and asserts:
 *
 *   - An existing devis with line items is seeded in the project.
 *   - An incoming intake document with the same reference + same HT total
 *     but changed line items reaches routingState="parked" (NOT "duplicate").
 *   - The parked notes contain "Possible revision".
 *   - The intake tab in the browser shows the "Parked" routing badge and
 *     the revision note excerpt on the document card.
 *
 * HOW THE AI STEP IS BYPASSED IN TESTS
 * ─────────────────────────────────────
 * The ingest queue reuses extractedData when it carries `preParsedFromEmail:
 * true` (Task #310 shortcut). By seeding the test intake document's
 * extracted_data column with that flag and the desired fields, the pipeline
 * skips the Gemini call and goes straight to dedup+routing with deterministic
 * data.
 *
 * HOW THE BYTE-DEDUP CONFLICT IS AVOIDED
 * ────────────────────────────────────────
 * To give the test doc a real storage key (without which the pipeline's
 * buffer-fetch step throws TransientIntakeError), we upload one "anchor" PDF
 * via the API and borrow its storage key. The anchor's DB row is then deleted
 * immediately so its fingerprint is no longer in the project — the byte-dedup
 * pass therefore finds nothing for the test doc and proceeds to the business-
 * identity (ref + amount + lines) dedup that we actually want to exercise.
 * The storage object itself is not deleted and remains accessible to the
 * pipeline.
 *
 * REQUIRES the dev server with ENABLE_DEV_LOGIN_FOR_E2E=true and DATABASE_URL
 * set in the test environment. All seeded rows are removed in finally.
 */

const SEED_PREFIX = "e2e-intake-dedup-rev-";

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

test("same-ref same-total different-lines intake document parks for revision review, not duplicate", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);

  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const email = `${SEED_PREFIX}${uniq}@local.test`;
  const devisRef = `DEV-${uniq.slice(0, 8).toUpperCase()}`;
  // HT amount shared by the seeded devis AND the incoming intake document.
  const amountHt = "2500.00";
  const amountTtc = "3000.00";

  const db = new Client({ connectionString: databaseUrl! });
  await db.connect();

  let projectId: number | null = null;
  let contractorId: number | null = null;
  let devisId: number | null = null;
  // The anchor upload row is deleted within the test body, but we track it
  // for the finally block in case the test fails before that deletion.
  let anchorDocId: number | null = null;
  let docId: number | null = null;

  try {
    // -----------------------------------------------------------------------
    // 1. Authenticate and create the project via the API (consistent with how
    //    other specs seed projects — ensures the project is owned by the test
    //    user's session).
    // -----------------------------------------------------------------------
    await devLogin(request, email);

    const projectRes = await request.post("/api/projects", {
      data: { name: `${SEED_PREFIX}project-${uniq}`, code: `${SEED_PREFIX}${uniq}`.slice(0, 20), clientName: "Revision Dedup Test Client" },
    });
    expect(projectRes.ok(), `project create failed: ${projectRes.status()}`).toBe(true);
    projectId = ((await projectRes.json()) as { id: number }).id;

    // -----------------------------------------------------------------------
    // 2. Seed: contractor + devis with two known line items.
    //    The incoming intake document will have the SAME ref + same HT total
    //    but DIFFERENT line items → must trigger the revision-park path.
    // -----------------------------------------------------------------------
    const contractorRes = await db.query<{ id: number }>(
      `INSERT INTO contractors (name) VALUES ($1) RETURNING id`,
      [`${SEED_PREFIX}contractor-${uniq}`],
    );
    contractorId = contractorRes.rows[0].id;

    const devisDbRes = await db.query<{ id: number }>(
      `INSERT INTO devis
         (project_id, contractor_id, devis_code, devis_number, description_fr,
          amount_ht, amount_ttc, accounting_state)
       VALUES ($1, $2, $3, $3, $4, $5, $6, 'active')
       RETURNING id`,
      [projectId, contractorId, devisRef, `${SEED_PREFIX}Travaux lot 1`, amountHt, amountTtc],
    );
    devisId = devisDbRes.rows[0].id;

    // Original line items on the existing devis.
    await db.query(
      `INSERT INTO devis_line_items
         (devis_id, line_number, description, quantity, unit_price_ht, total_ht)
       VALUES ($1, 1, 'Fourniture et pose revêtement sol', '1.000', '1500.00', '1500.00'),
              ($1, 2, 'Peinture murs et plafonds', '1.000', '1000.00', '1000.00')`,
      [devisId],
    );

    // -----------------------------------------------------------------------
    // 3. Upload a minimal valid PDF via the API to obtain a real storage key.
    //    The upload auto-triggers an ingest job for the anchor document, but
    //    we delete that DB row immediately afterwards (step 4) so the auto-job
    //    exits cleanly and the fingerprint no longer exists in the project.
    // -----------------------------------------------------------------------
    // Minimal PDF that passes the magic-byte guard in the ingest pipeline.
    const minimalPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type /Pages /Kids [3 0 R] /Count 1>>endobj\n" +
      "3 0 obj<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>endobj\n" +
      "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n" +
      "0000000058 00000 n \n0000000115 00000 n \n" +
      "trailer<</Size 4 /Root 1 0 R>>\nstartxref\n190\n%%EOF",
    );

    const uploadRes = await request.post(`/api/projects/${projectId}/intake/upload`, {
      multipart: {
        file: {
          name: `${SEED_PREFIX}anchor-${uniq}.pdf`,
          mimeType: "application/pdf",
          buffer: minimalPdf,
        },
      },
    });
    expect(uploadRes.ok(), `Anchor upload failed: ${uploadRes.status()}`).toBe(true);
    const { id: uploadedId, storageKey } = (await uploadRes.json()) as { id: number; storageKey: string };
    anchorDocId = uploadedId;

    // -----------------------------------------------------------------------
    // 4. Delete the anchor DB row immediately so the pipeline's byte-dedup
    //    pass finds no prior document with the same fingerprint when the test
    //    document is processed. The storage object (at storageKey) is not
    //    deleted — the pipeline can still read the bytes.
    //    The cascade on intake_jobs cleans up the auto-triggered queue row;
    //    if the job is already in flight it exits cleanly when it finds the
    //    doc gone (runPipeline returns early on null doc).
    // -----------------------------------------------------------------------
    await db.query(`DELETE FROM project_intake_documents WHERE id = $1`, [anchorDocId]);
    anchorDocId = null; // prevent double-delete in finally

    // -----------------------------------------------------------------------
    // 5. Seed the revision intake document directly in the DB.
    //    - storage_key: same PDF bytes → real buffer for the pipeline.
    //    - extractedData: preParsedFromEmail: true so AI parsing is skipped.
    //    - Same devis reference + same HT total as the seeded devis.
    //    - COMPLETELY DIFFERENT line items (same total cost, swapped content).
    // -----------------------------------------------------------------------
    const incomingExtractedData = {
      preParsedFromEmail: true,
      documentType: "quotation",
      devisNumber: devisRef,
      reference: devisRef,
      // amountHt must be a number for DedupExtraction (the dedup function
      // reads parsed.amountHt directly and passes it to amountsMatch as `a`).
      amountHt: 2500,
      amountTtc: 3000,
      contractorName: `${SEED_PREFIX}contractor-${uniq}`,
      lineItems: [
        // Completely different items from the seeded ones — same HT total.
        { description: "Démolition cloisons existantes", quantity: "1", unitPrice: "900.00", total: "900.00" },
        { description: "Construction cloisons neuves BA13", quantity: "1", unitPrice: "1600.00", total: "1600.00" },
      ],
    };

    const doc2Res = await db.query<{ id: number }>(
      `INSERT INTO project_intake_documents
         (project_id, file_name, storage_key, mime_type, source,
          analysis_state, routing_state, extracted_data, uploaded_by)
       VALUES ($1, $2, $3, 'application/pdf', 'email',
               'pending', 'unrouted', $4::jsonb, 'e2e')
       RETURNING id`,
      [
        projectId,
        `${SEED_PREFIX}revision-${uniq}.pdf`,
        storageKey,
        JSON.stringify(incomingExtractedData),
      ],
    );
    docId = doc2Res.rows[0].id;

    // -----------------------------------------------------------------------
    // 6. Trigger the ingest pipeline on docId via the reanalyze endpoint.
    //    With preParsedFromEmail: true in extractedData the pipeline skips AI
    //    and goes straight to dedup → detects revision → parks for review.
    // -----------------------------------------------------------------------
    const reanalyzeRes = await request.post(`/api/intake-documents/${docId}/reanalyze`);
    expect(reanalyzeRes.ok(), `Reanalyze failed: ${reanalyzeRes.status()}`).toBe(true);

    // -----------------------------------------------------------------------
    // 7. Poll the intake list until the doc reaches a terminal analysis state
    //    ("analyzed"). The pipeline fires the inline attempt before returning
    //    the HTTP response, so it typically settles within a second.
    // -----------------------------------------------------------------------
    let finalDoc: {
      id: number;
      analysisState: string;
      routingState: string;
      notes: string | null;
    } | null = null;

    await expect
      .poll(
        async () => {
          const listRes = await request.get(`/api/projects/${projectId}/intake`);
          if (!listRes.ok()) return null;
          const docs = (await listRes.json()) as Array<{
            id: number;
            analysisState: string;
            routingState: string;
            notes: string | null;
          }>;
          const match = docs.find((d) => d.id === docId);
          if (match && match.analysisState === "analyzed") {
            finalDoc = match;
            return match.analysisState;
          }
          return match?.analysisState ?? null;
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe("analyzed");

    // -----------------------------------------------------------------------
    // 8. Assert dedup verdict: parked (revision), NOT duplicate.
    // -----------------------------------------------------------------------
    expect(
      finalDoc!.routingState,
      "expected routingState 'parked' (revision review), NOT 'duplicate'",
    ).toBe("parked");

    expect(
      finalDoc!.notes ?? "",
      "expected notes to contain 'Possible revision'",
    ).toContain("Possible revision");

    expect(
      finalDoc!.notes ?? "",
      "expected notes NOT to contain 'Duplicate of'",
    ).not.toContain("Duplicate of");

    // -----------------------------------------------------------------------
    // 9. Browser surface: intake tab should show the "Parked" routing badge
    //    and the revision note excerpt on the document card.
    // -----------------------------------------------------------------------
    await devLogin(page.request, email);
    await page.goto(`/projets/${projectId}`);
    await page.getByTestId("tab-intake").click();

    const docCard = page.getByTestId(`card-intake-doc-${docId}`);
    await expect(docCard).toBeVisible();

    // Routing badge reads "Parked" (from routingLabel in IntakeTab.tsx).
    const routingBadge = page.getByTestId(`routing-intake-${docId}`);
    await expect(routingBadge).toBeVisible();
    await expect(routingBadge).toHaveText(/Parked/i);

    // Notes excerpt (line-clamped) is visible on the card for parked docs.
    const notesEl = page.getByTestId(`text-intake-notes-${docId}`);
    await expect(notesEl).toBeVisible();
    await expect(notesEl).toContainText(/Possible revision/i);
  } finally {
    // Remove seeded rows in FK-safe order. Cascade deletes handle intake_jobs.
    try {
      if (docId) await db.query(`DELETE FROM project_intake_documents WHERE id = $1`, [docId]);
      if (anchorDocId) await db.query(`DELETE FROM project_intake_documents WHERE id = $1`, [anchorDocId]);
      if (devisId) await db.query(`DELETE FROM devis WHERE id = $1`, [devisId]);
      if (contractorId) await db.query(`DELETE FROM contractors WHERE id = $1`, [contractorId]);
      if (projectId) await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    } finally {
      await db.end();
    }
  }
});
