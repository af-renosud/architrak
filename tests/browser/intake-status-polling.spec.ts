import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the intake status badge polling (Task #337, follows #327).
 *
 * Task #327 added a 3s refetchInterval on the Intake tab while any document
 * is pending/analyzing. Live verification saw the terminal state land without
 * a reload, but the pipeline completed so fast the intermediate
 * "Pending analysis"/"Analyzing" badge was never actually witnessed.
 *
 * This test removes the timing luck: it seeds an intake document directly in
 * the DB (no queue job, so the real pipeline never touches it), then flips its
 * analysis_state via SQL mid-test and asserts the on-screen badge follows:
 *   - badge shows "Pending analysis" on load;
 *   - after a DB flip to `analyzing`, polling updates it to "Analyzing"
 *     WITHOUT a page reload;
 *   - after a DB flip to `analyzed`, the badge reaches "Analyzed";
 *   - once terminal, polling STOPS — no further GET /api/projects/:id/intake
 *     requests are observed.
 *
 * REQUIRES the server booted with ENABLE_DEV_LOGIN_FOR_E2E=true and
 * DATABASE_URL set in the test environment.
 *
 * All seeded rows are removed in the finally block regardless of pass/fail.
 */

const SEED_PREFIX = "e2e-intake-poll-";

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

test("intake badge transitions pending → analyzing → analyzed via polling, then polling stops", async ({ page, request }) => {
  test.setTimeout(90_000);
  const uniq = `${Date.now()}`.slice(-8);
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();

  let projectId: number | null = null;
  let docId: number | null = null;
  try {
    // --- Seed: project + one intake doc parked in `pending`. No intake_jobs
    // row is created, so the real pipeline/sweeper never advances it — the
    // test owns every state transition via SQL.
    const projectRes = await db.query<{ id: number }>(
      `INSERT INTO projects (name, code, client_name)
       VALUES ($1, $2, 'Polling Client') RETURNING id`,
      [`${SEED_PREFIX}project-${uniq}`, `${SEED_PREFIX}${uniq}`],
    );
    projectId = projectRes.rows[0].id;
    const docRes = await db.query<{ id: number }>(
      `INSERT INTO project_intake_documents
         (project_id, file_name, storage_key, mime_type, source, analysis_state, routing_state, uploaded_by)
       VALUES ($1, $2, $3, 'application/pdf', 'manual', 'pending', 'unrouted', 'e2e')
       RETURNING id`,
      [projectId, `${SEED_PREFIX}doc-${uniq}.pdf`, `${SEED_PREFIX}nonexistent-${uniq}`],
    );
    docId = docRes.rows[0].id;

    // --- Track every intake-list poll and any full page (re)load.
    let intakeGets = 0;
    page.on("request", (req) => {
      // The query key joins to "/api/projects/:id/intake/" (trailing slash
      // from the empty includeVoid segment) — match by prefix.
      if (req.method() === "GET" && new URL(req.url()).pathname.startsWith(`/api/projects/${projectId}/intake`)) {
        intakeGets += 1;
      }
    });

    await devLogin(page.request, "intake-poll-e2e@renosud.com");
    await page.goto(`/projets/${projectId}`);
    await page.getByTestId("tab-intake").click();

    // Plant a marker on window — if the page ever reloads, it vanishes.
    await page.evaluate(() => {
      (window as unknown as { __noReloadMarker: boolean }).__noReloadMarker = true;
    });

    const badge = page.getByTestId(`status-intake-${docId}`);
    await expect(badge).toHaveText("Pending analysis");

    // --- Flip to `analyzing`: the 3s poll must pick it up in place.
    await db.query(`UPDATE project_intake_documents SET analysis_state = 'analyzing' WHERE id = $1`, [docId]);
    await expect(badge).toHaveText("Analyzing", { timeout: 10_000 });

    // --- Flip to terminal `analyzed`: poll must land the final state.
    await db.query(
      `UPDATE project_intake_documents SET analysis_state = 'analyzed', routing_state = 'parked' WHERE id = $1`,
      [docId],
    );
    await expect(badge).toHaveText("Analyzed", { timeout: 10_000 });

    // No reload happened across the whole transition.
    const markerStillThere = await page.evaluate(
      () => (window as unknown as { __noReloadMarker?: boolean }).__noReloadMarker === true,
    );
    expect(markerStillThere, "page must not have reloaded during the badge transitions").toBe(true);

    // --- Polling must stop once every doc is terminal. Give the client a
    // beat to process the terminal payload, snapshot the counter, then wait
    // well over two 3s poll intervals and assert no further intake GETs.
    await page.waitForTimeout(1_000);
    const countAfterTerminal = intakeGets;
    expect(countAfterTerminal).toBeGreaterThanOrEqual(2); // initial load + at least one poll
    await page.waitForTimeout(8_000);
    expect(
      intakeGets,
      `polling must stop after terminal state (saw ${intakeGets - countAfterTerminal} extra GETs)`,
    ).toBe(countAfterTerminal);
  } finally {
    try {
      if (docId) await db.query(`DELETE FROM project_intake_documents WHERE id = $1`, [docId]);
      if (projectId) await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    } finally {
      await db.end();
    }
  }
});
