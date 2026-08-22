/**
 * Task #656 — Planning Envelope: Archidoc technical lot selector
 *
 * Verifies:
 * - Active lots appear in display order with "code — labelFr" format
 * - Selecting a lot, saving, and reopening persists the selection
 * - An inactive/tombstoned lot saved on a historical revision remains visible
 *   on that revision but is labelled "No longer active"
 * - The inactive lot does NOT appear as a selectable choice for new revisions
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

async function devLogin(api: APIRequestContext, email: string) {
  const response = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    response.ok(),
    `dev-login failed (${response.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

test.describe("Planning technical lot selector", () => {
  test("active options in order, save/reopen persistence, inactive historical selection", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-tech-lots-${unique}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await db.connect();

    let projectId: number | null = null;
    let previousCatalogue: {
      singleton_key: number;
      revision: string;
      changed_at: Date;
      source_base_url: string | null;
      synced_at: Date;
    } | null = null;
    // archidoc_technical_lots uses archidoc_id (varchar) as PK — we store them for cleanup
    const lotIds: string[] = [];

    try {
      const api = context.request;
      await devLogin(api, email);
      const priorCatalogueResult = await db.query<{
        singleton_key: number;
        revision: string;
        changed_at: Date;
        source_base_url: string | null;
        synced_at: Date;
      }>(
        `SELECT singleton_key, revision, changed_at, source_base_url, synced_at
           FROM archidoc_technical_lot_catalogue
          WHERE singleton_key = 1`,
      );
      previousCatalogue = priorCatalogueResult.rows[0] ?? null;

      // Create a project
      const projectResponse = await api.post("/api/projects", {
        data: {
          name: `Planning technical lots project ${unique}`,
          code: `PLAN-TL-${unique.slice(0, 8)}`,
          clientName: "Tech Lot Client",
        },
      });
      expect(projectResponse.ok()).toBe(true);
      const project = (await projectResponse.json()) as { id: number };
      projectId = project.id;

      // ──────────────────────────────────────────────────────────────────────
      // Seed technical lots
      // ──────────────────────────────────────────────────────────────────────
      // Two active lots (display order 10 and 20) + one inactive/tombstoned lot (display order 5)
      const activeId1 = `e2e-tl-active1-${unique}`;
      const activeId2 = `e2e-tl-active2-${unique}`;
      const inactiveId = `e2e-tl-inactive-${unique}`;
      lotIds.push(activeId1, activeId2, inactiveId);

      const now = new Date().toISOString();

      await db.query(
        `INSERT INTO archidoc_technical_lots
           (archidoc_id, code, label_fr, display_order, is_active, deleted_at,
            archidoc_created_at, archidoc_updated_at)
         VALUES
           ($1, $2, $3, 10, true,  NULL, $7, $7),
           ($4, $5, $6, 20, true,  NULL, $7, $7)`,
        [
          activeId1,
          `LOT-A-${unique.slice(0, 6)}`,
          `Lot Alpha ${unique.slice(0, 6)}`,
          activeId2,
          `LOT-B-${unique.slice(0, 6)}`,
          `Lot Beta ${unique.slice(0, 6)}`,
          now,
        ],
      );

      // Tombstoned lot: is_active=false, deleted_at set
      await db.query(
        `INSERT INTO archidoc_technical_lots
           (archidoc_id, code, label_fr, display_order, is_active, deleted_at,
            archidoc_created_at, archidoc_updated_at)
         VALUES ($1, $2, $3, 5, false, $4, $4, $4)`,
        [
          inactiveId,
          `LOT-OLD-${unique.slice(0, 6)}`,
          `Lot Old ${unique.slice(0, 6)}`,
          now,
        ],
      );

      // Seed catalogue row (upsert — singleton key=1)
      await db.query(
        `INSERT INTO archidoc_technical_lot_catalogue (singleton_key, revision, changed_at)
         VALUES (1, 42, $1)
         ON CONFLICT (singleton_key) DO UPDATE SET revision = 42, changed_at = $1`,
        [now],
      );

      // ──────────────────────────────────────────────────────────────────────
      // Seed a planning draft revision with the INACTIVE lot saved on it
      // (simulates a historical revision where lot was active at save time)
      // ──────────────────────────────────────────────────────────────────────
      await db.query("BEGIN");
      let historicRevisionId: number;
      try {
        const envelopeResult = await db.query<{ id: number }>(
          `INSERT INTO planning_envelopes (project_id) VALUES ($1) RETURNING id`,
          [projectId],
        );
        const envelopeId = envelopeResult.rows[0].id;

        const revResult = await db.query<{ id: number }>(
          `INSERT INTO planning_revisions
             (envelope_id, reference, description_fr, amount_ht, amount_ttc,
              archidoc_technical_lot_id, created_by)
           VALUES ($1, $2, $3, '500.00', '600.00', $4, $5)
           RETURNING id`,
          [
            envelopeId,
            `HIST-${unique.slice(0, 8)}`,
            "Historic revision with now-inactive lot",
            inactiveId,
            email,
          ],
        );
        historicRevisionId = revResult.rows[0].id;
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      }

      // ──────────────────────────────────────────────────────────────────────
      // Browser: navigate to planning tab, open the historic revision
      // ──────────────────────────────────────────────────────────────────────
      const page = await context.newPage();
      await page.goto(`/projets/${projectId}?tab=planning-envelope`);
      await expect(page.getByTestId("panel-planning-envelope")).toBeVisible();

      // The historic revision card should be visible
      await expect(
        page.getByTestId(`planning-envelope-revision-${historicRevisionId}`),
      ).toBeVisible();

      // Open the historic revision in the edit dialog
      await page.getByTestId(`planning-envelope-edit-${historicRevisionId}`).click();
      await expect(page.getByTestId("planning-envelope-form")).toBeVisible();

      // The inactive lot must be visible as the current value on this revision
      // It should be labelled "No longer active"
      const lotTrigger = page.getByTestId("planning-envelope-form-lot");
      await expect(lotTrigger).toBeVisible();
      // The trigger shows the currently selected value — it should contain the inactive lot code
      await expect(lotTrigger).toContainText(`LOT-OLD-${unique.slice(0, 6)}`);

      // Open the dropdown to inspect options
      await lotTrigger.click();

      const inactiveOption = page.getByTestId(`planning-lot-option-inactive-${inactiveId}`);
      await expect(inactiveOption).toBeVisible();
      await expect(inactiveOption).toContainText("No longer active");

      // Active lots should also be present
      const activeOption1 = page.getByTestId(`planning-lot-option-${activeId1}`);
      const activeOption2 = page.getByTestId(`planning-lot-option-${activeId2}`);
      await expect(activeOption1).toBeVisible();
      await expect(activeOption2).toBeVisible();

      // Verify display order: LOT-A (displayOrder 10) appears before LOT-B (displayOrder 20)
      // in the selector content. Use locator ordering by index.
      const lotContent = page.locator("[data-testid='planning-envelope-form-lot']").locator("..");
      // We check that activeOption1 appears before activeOption2 in DOM order
      const allOptions = page.getByRole("option");
      const option1Idx = await allOptions.evaluateAll(
        (nodes, id) => nodes.findIndex((n) => n.getAttribute("data-testid") === `planning-lot-option-${id}`),
        activeId1,
      );
      const option2Idx = await allOptions.evaluateAll(
        (nodes, id) => nodes.findIndex((n) => n.getAttribute("data-testid") === `planning-lot-option-${id}`),
        activeId2,
      );
      expect(option1Idx).toBeGreaterThanOrEqual(0);
      expect(option2Idx).toBeGreaterThanOrEqual(0);
      expect(option1Idx).toBeLessThan(option2Idx);

      // Close dropdown by pressing Escape
      await page.keyboard.press("Escape");

      // Close the dialog
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("planning-envelope-form")).toHaveCount(0);

      // ──────────────────────────────────────────────────────────────────────
      // New revision: active lot selection, save, and reopen persistence
      // ──────────────────────────────────────────────────────────────────────
      await page.getByTestId("planning-envelope-new").click();
      await expect(page.getByTestId("planning-envelope-form")).toBeVisible();

      // Fill required fields
      await page.getByTestId("planning-envelope-form-reference").fill(`TL-${unique.slice(0, 8)}`);
      await page.getByTestId("planning-envelope-form-scope").fill("Technical lot test revision");
      await page.getByTestId("planning-envelope-form-ht").fill("1000");
      await page.getByTestId("planning-envelope-form-ttc").fill("1200");

      // Open the lot selector
      await page.getByTestId("planning-envelope-form-lot").click();

      // The inactive lot should NOT appear as a selectable option on a NEW revision
      // (it only appears on the historic revision edit as a saved value)
      await expect(page.getByTestId(`planning-lot-option-inactive-${inactiveId}`)).toHaveCount(0);

      // Select activeId1
      await page.getByTestId(`planning-lot-option-${activeId1}`).click();

      // Verify the lot label is shown in "code — labelFr" format in the trigger
      await expect(page.getByTestId("planning-envelope-form-lot")).toContainText(
        `LOT-A-${unique.slice(0, 6)} — Lot Alpha ${unique.slice(0, 6)}`,
      );

      // Save the revision
      const [createResponse] = await Promise.all([
        page.waitForResponse(
          (resp) =>
            resp.request().method() === "POST" &&
            resp.url().includes(`/api/projects/${projectId}/planning-envelope/revisions`),
        ),
        page.getByTestId("planning-envelope-form-submit").click(),
      ]);
      expect(createResponse.ok()).toBe(true);
      await expect(page.getByTestId("planning-envelope-form")).toHaveCount(0);

      // Retrieve the saved revision id via API
      const summaryResp = await api.get(`/api/projects/${projectId}/planning-envelope`);
      expect(summaryResp.ok()).toBe(true);
      const summaryBody = (await summaryResp.json()) as {
        revisions: Array<{
          revision: { id: number; archidocTechnicalLotId: string | null; status: string };
          technicalLot: { id: string; code: string; labelFr: string } | null;
        }>;
      };

      // Find the newly created revision (not the historic one)
      const newRevision = summaryBody.revisions.find(
        (rv) => rv.revision.id !== historicRevisionId,
      );
      expect(newRevision).toBeDefined();
      expect(newRevision!.revision.archidocTechnicalLotId).toBe(activeId1);
      expect(newRevision!.technicalLot).not.toBeNull();
      expect(newRevision!.technicalLot!.code).toBe(`LOT-A-${unique.slice(0, 6)}`);

      const newRevisionId = newRevision!.revision.id;

      // Reopen the saved revision and verify lot persists
      await page.getByTestId(`planning-envelope-edit-${newRevisionId}`).click();
      await expect(page.getByTestId("planning-envelope-form")).toBeVisible();

      // The lot trigger should show the saved lot
      await expect(page.getByTestId("planning-envelope-form-lot")).toContainText(
        `LOT-A-${unique.slice(0, 6)}`,
      );

      // Close dialog
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("planning-envelope-form")).toHaveCount(0);

      // Verify revision card shows the technical lot label
      const revCard = page.getByTestId(`planning-envelope-revision-${newRevisionId}`);
      await expect(revCard).toContainText(`LOT-A-${unique.slice(0, 6)}`);
    } finally {
      if (projectId != null) {
        await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
      // Clean up seeded technical lots (FK restrict means revisions must be gone first, which DELETE projects handles via cascade)
      for (const lotId of lotIds) {
        await db
          .query("DELETE FROM archidoc_technical_lots WHERE archidoc_id = $1", [lotId])
          .catch(() => undefined);
      }
      if (previousCatalogue) {
        await db.query(
          `INSERT INTO archidoc_technical_lot_catalogue
             (singleton_key, revision, changed_at, source_base_url, synced_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (singleton_key) DO UPDATE SET
             revision = EXCLUDED.revision,
             changed_at = EXCLUDED.changed_at,
             source_base_url = EXCLUDED.source_base_url,
             synced_at = EXCLUDED.synced_at`,
          [
            previousCatalogue.singleton_key,
            previousCatalogue.revision,
            previousCatalogue.changed_at,
            previousCatalogue.source_base_url,
            previousCatalogue.synced_at,
          ],
        );
      } else {
        await db.query(
          "DELETE FROM archidoc_technical_lot_catalogue WHERE singleton_key = 1",
        );
      }
      await db.query("DELETE FROM users WHERE email = $1", [email]).catch(() => undefined);
      await context.close();
      await db.end();
    }
  });
});
