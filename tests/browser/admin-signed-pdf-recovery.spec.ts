import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the Signed-PDF recovery admin Ops page (task #207).
 *
 * Per task #211's "Done looks like" the persist service is stubbed at
 * the network layer so this remains a hermetic browser test focused on
 * the UI contract:
 *   - List query renders the right rows.
 *   - Retention-breached rows render the badge and disable Retry.
 *   - Retry click → mutation → query invalidation removes the row.
 *
 * Backend retry-route logic (the 409 guards, persist invocation, and
 * recovered-flag branching) is covered separately by the route's
 * integration tests; this spec deliberately does NOT exercise the
 * downstream Archisign / object-storage path so it doesn't take a
 * dependency on those services being reachable from CI.
 *
 * Seeds:
 *   1. A "recoverable" devis at stage `client_signed_off` with an
 *      Archisign envelope id and NULL `signed_pdf_storage_key` — the
 *      exact predicate `listSignedPdfRecoveryCandidates` selects.
 *   2. A second equivalent devis PLUS a row in
 *      `signed_pdf_retention_breaches` so the LEFT JOIN surfaces a
 *      retention-breached row that must render read-only.
 */

const SEED_PREFIX = "e2e-signed-pdf-recovery-";

interface Seeded {
  projectId: number;
  contractorId: number;
  recoverableDevisId: number;
  breachedDevisId: number;
  breachId: number;
  recoverableEnvelopeId: string;
  breachedEnvelopeId: string;
}

async function devLogin(
  api: { post: (url: string, opts: { data: unknown }) => Promise<{ ok: () => boolean; status: () => number }> },
  email: string,
) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const projectRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${SEED_PREFIX}project-${uniq}`, `${SEED_PREFIX}${uniq}`, "Test Client"],
  );
  const projectId = projectRes.rows[0].id;

  const contractorRes = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, email)
     VALUES ($1, $2) RETURNING id`,
    [`${SEED_PREFIX}contractor-${uniq}`, `${SEED_PREFIX}${uniq}@local.test`],
  );
  const contractorId = contractorRes.rows[0].id;

  const recoverableEnvelopeId = `env-recoverable-${uniq}`;
  const breachedEnvelopeId = `env-breached-${uniq}`;

  const recoverableRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc,
        sign_off_stage, archisign_envelope_id, signed_pdf_storage_key, date_signed)
     VALUES ($1, $2, $3, $4, $5, $6, 'client_signed_off', $7, NULL, CURRENT_DATE)
     RETURNING id`,
    [
      projectId,
      contractorId,
      `${SEED_PREFIX}D-OK-${uniq}`,
      "Recoverable signed devis (audit copy missing)",
      "100.00",
      "120.00",
      recoverableEnvelopeId,
    ],
  );
  const recoverableDevisId = recoverableRes.rows[0].id;

  const breachedRes = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc,
        sign_off_stage, archisign_envelope_id, signed_pdf_storage_key, date_signed)
     VALUES ($1, $2, $3, $4, $5, $6, 'client_signed_off', $7, NULL, CURRENT_DATE)
     RETURNING id`,
    [
      projectId,
      contractorId,
      `${SEED_PREFIX}D-BR-${uniq}`,
      "Retention-breached signed devis",
      "200.00",
      "240.00",
      breachedEnvelopeId,
    ],
  );
  const breachedDevisId = breachedRes.rows[0].id;

  const breachRes = await db.query<{ id: number }>(
    `INSERT INTO signed_pdf_retention_breaches
       (devis_id, archisign_envelope_id, event_source, original_signed_at,
        detected_at, incident_ref, remediation_contact)
     VALUES ($1, $2, 'archisign', NOW() - INTERVAL '40 days', NOW(),
             $3, 'ops@archisign.test')
     RETURNING id`,
    [breachedDevisId, breachedEnvelopeId, `INC-${uniq}`],
  );
  const breachId = breachRes.rows[0].id;

  return {
    projectId,
    contractorId,
    recoverableDevisId,
    breachedDevisId,
    breachId,
    recoverableEnvelopeId,
    breachedEnvelopeId,
  };
}

async function cleanup(db: Client, s: Seeded | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM signed_pdf_retention_breaches WHERE id = $1", [s.breachId]],
    ["DELETE FROM devis WHERE id = ANY($1)", [[s.recoverableDevisId, s.breachedDevisId]]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[signed-pdf-recovery cleanup] swallowed:", (err as Error).message);
    }
  }
}

test.describe("Admin — Signed-PDF recovery page (task #207)", () => {
  test("lists candidates, disables Retry on retention-breached, removes row after successful retry", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-signed-pdf-recovery-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext();
    let seeded: Seeded | null = null;
    try {
      seeded = await seed(db, uniq);
      await devLogin(context.request, email);

      const page = await context.newPage();

      // Stub the persist service at the network layer (per task #211's
      // "Done looks like"): the page treats `recovered: true` as
      // success and invalidates the list query. The retry route's
      // server-side contract is covered by separate integration tests.
      const retryUrl = `**/api/admin/signed-pdf-recovery/${seeded.recoverableDevisId}/retry`;
      let retryCalled = false;
      await page.route(retryUrl, async (route) => {
        if (route.request().method() === "POST") {
          retryCalled = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: seeded!.recoverableDevisId,
              recovered: true,
              signedPdfStorageKey: `private/devis-signed/${seeded!.recoverableDevisId}.pdf`,
              signedPdfLastError: null,
              signedPdfRetryAttempts: 0,
            }),
          });
        } else {
          await route.continue();
        }
      });

      // Stub the list GET so the post-retry refetch returns ONLY the
      // breached row (simulating the server's view after a successful
      // persist removes the recoverable row from the predicate). We
      // toggle behaviour after the POST so the initial render still
      // shows both rows from the real backend on first load.
      const listUrl = "**/api/admin/signed-pdf-recovery";
      const breachedOnlyBody = {
        rows: [
          {
            id: seeded.breachedDevisId,
            devisCode: `${SEED_PREFIX}D-BR-${uniq}`,
            projectId: seeded.projectId,
            lotId: null,
            archisignEnvelopeId: seeded.breachedEnvelopeId,
            signedPdfRetryAttempts: 0,
            signedPdfNextAttemptAt: null,
            signedPdfLastError: null,
            dateSigned: new Date().toISOString(),
            retentionBreachedAt: new Date().toISOString(),
            retentionIncidentRef: `INC-${uniq}`,
          },
        ],
      };
      await page.route(listUrl, async (route) => {
        if (route.request().method() === "GET" && retryCalled) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(breachedOnlyBody),
          });
        } else {
          await route.continue();
        }
      });

      await page.goto("/admin/ops/signed-pdf-recovery");
      await expect(page.getByTestId("page-admin-signed-pdf-recovery")).toBeVisible();

      const recoverableRow = page.getByTestId(`row-recovery-${seeded.recoverableDevisId}`);
      const breachedRow = page.getByTestId(`row-recovery-${seeded.breachedDevisId}`);
      await expect(recoverableRow).toBeVisible();
      await expect(breachedRow).toBeVisible();

      // Breached row: badge visible, Retry disabled.
      await expect(
        page.getByTestId(`badge-retention-${seeded.breachedDevisId}`),
      ).toBeVisible();
      await expect(
        page.getByTestId(`button-retry-${seeded.breachedDevisId}`),
      ).toBeDisabled();

      // Recoverable row: Retry enabled, click it.
      const retryBtn = page.getByTestId(`button-retry-${seeded.recoverableDevisId}`);
      await expect(retryBtn).toBeEnabled();
      await retryBtn.click();

      // Success toast and the recoverable row disappears after the
      // refetched list omits it. The breached row must still render
      // (guards against a regression that hides everything on refetch).
      await expect(
        page.getByText("Signed PDF recovered", { exact: true }).first(),
      ).toBeVisible({ timeout: 5_000 });
      await expect(recoverableRow).toBeHidden({ timeout: 5_000 });
      await expect(breachedRow).toBeVisible();
      expect(retryCalled, "POST /retry was not invoked").toBe(true);
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
