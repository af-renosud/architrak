import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for Task #522 — bulk-retry failed contractor payment notices.
 *
 * Verifies the full flow on the Communication Hub (/communications):
 *   1. Seeds a contractor with NO email and two failed
 *      `certificat_contractor_notice` rows linked to a certificat.
 *   2. Confirms the FailedContractorNoticesPanel appears with the contractor's
 *      row (data-testid: panel-failed-contractor-notices,
 *      row-failed-notices-{contractorId}).
 *   3. Patches the contractor's email via PATCH /api/contractors/:id so the
 *      retry send has a valid recipient.
 *   4. Clicks "Renvoyer tout" (button-retry-notices-{contractorId}) and
 *      confirms the panel disappears (all notices retried successfully).
 *
 * Seeding: project + contractor via API; certificat + communications via
 * direct SQL (no public API produces failed contractor notices deterministically).
 *
 * Requires NODE_ENV=development, ENABLE_DEV_LOGIN_FOR_E2E=true,
 * E2E_FAKE_GMAIL=true and DATABASE_URL.
 */

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function postOk<T = unknown>(
  api: APIRequestContext,
  url: string,
  body: unknown,
): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `POST ${url} failed: ${res.status()} ${await safeText(res)}`).toBe(true);
  return (await res.json()) as T;
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

test.describe("Communications hub — retry all failed contractor notices (task #522)", () => {
  test("panel appears for contractor with failed notices; retry after email fix makes it disappear", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const architectEmail = `e2e-retry-notices-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

    let projectId: number | null = null;
    let contractorId: number | null = null;
    let certificatId: number | null = null;
    const commIds: number[] = [];

    try {
      await devLogin(context.request, architectEmail);

      // 1. Create a contractor with NO email address.
      const contractor = await postOk<{ id: number }>(context.request, "/api/contractors", {
        name: `RetryTest Co ${uniq}`,
        // email intentionally omitted
      });
      contractorId = contractor.id;

      // 2. Create a project (needed for the certificat FK).
      const project = await postOk<{ id: number }>(context.request, "/api/projects", {
        name: `RetryTest Proj ${uniq}`,
        code: `RN-${uniq.slice(0, 8)}`,
        clientName: "Retry Client",
        clientContactName: "Retry Contact",
        clientContactEmail: `client-${uniq}@local.test`,
      });
      projectId = project.id;

      // 3. Insert a certificat directly (avoids complex deduction-math API).
      const certResult = await db.query(
        `INSERT INTO certificats
           (project_id, contractor_id, certificate_ref, total_works_ht,
            net_to_pay_ht, tva_amount, net_to_pay_ttc,
            cumulative_prorata_deduction, period_prorata_deduction,
            cumulative_acompte_recoupment, period_acompte_recoupment,
            tva_rate_percent, tva_rate_source, status)
         VALUES ($1, $2, $3, '5000.00', '4500.00', '900.00', '5400.00',
                 '0.00', '0.00', '0.00', '0.00', '20.00', 'default', 'draft')
         RETURNING id`,
        [projectId, contractorId, `CERT-RN-${uniq}`],
      );
      certificatId = certResult.rows[0].id as number;

      // 4. Insert two failed certificat_contractor_notice communications.
      for (let i = 0; i < 2; i++) {
        const inserted = await db.query(
          `INSERT INTO project_communications
             (project_id, type, recipient_type, recipient_email, recipient_name,
              subject, body, status, related_certificat_id)
           VALUES ($1, 'certificat_contractor_notice', 'contractor', '', $2,
                   $3, 'Avis de paiement e2e', 'failed', $4)
           RETURNING id`,
          [
            projectId,
            `RetryTest Co ${uniq}`,
            `Avis de paiement CERT-RN-${uniq} #${i + 1}`,
            certificatId,
          ],
        );
        commIds.push(inserted.rows[0].id as number);
      }

      // ── Navigate to the communications hub ──────────────────────────────
      const page = await context.newPage();
      await page.goto("/communications");

      // 5. Confirm the FailedContractorNoticesPanel is visible.
      const panel = page.getByTestId("panel-failed-contractor-notices");
      await expect(panel).toBeVisible();

      // The contractor's row must be present.
      const row = panel.getByTestId(`row-failed-notices-${contractorId}`);
      await expect(row).toBeVisible();
      await expect(row.getByText("RetryTest Co " + uniq)).toBeVisible();
      await expect(row.getByText(/2 avis en échec/)).toBeVisible();

      // 6. Patch the contractor's email so the retry has a valid recipient.
      const patchRes = await context.request.patch(`/api/contractors/${contractorId}`, {
        data: { email: `contractor-fixed-${uniq}@local.test` },
      });
      expect(
        patchRes.ok(),
        `PATCH contractor email failed: ${patchRes.status()} ${await safeText(patchRes)}`,
      ).toBe(true);

      // 7. Click "Renvoyer tout" and wait for the panel to disappear.
      const retryBtn = page.getByTestId(`button-retry-notices-${contractorId}`);
      await expect(retryBtn).toBeVisible();
      await retryBtn.click();

      // Success toast: all notices retried.
      await expect(page.getByText(/avis relancé/i).first()).toBeVisible();

      // Panel vanishes once there are no more failed groups for this contractor.
      await expect(
        page.getByTestId(`row-failed-notices-${contractorId}`),
      ).toHaveCount(0);
    } finally {
      try {
        if (commIds.length > 0) {
          await db.query(
            `DELETE FROM project_communications WHERE id = ANY($1::int[])`,
            [commIds],
          );
        }
        if (certificatId) {
          await db.query("DELETE FROM certificats WHERE id = $1", [certificatId]);
        }
        if (projectId) {
          await db.query("DELETE FROM project_communications WHERE project_id = $1", [projectId]);
          await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
        }
        if (contractorId) {
          await db.query("DELETE FROM contractors WHERE id = $1", [contractorId]);
        }
      } catch (err) {
        console.warn("[retry-notices cleanup] swallowed:", (err as Error).message);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
