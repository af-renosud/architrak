import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * E2E coverage for the admin Pennylane push DLQ retry flow (Task #222).
 *
 * Seeds a `pennylane_pushes` row in state='dead_letter' for a synthetic
 * project, opens /admin/ops/pennylane-pushes, filters by `dead_letter`
 * so the row is visible, clicks the per-row Retry button, and asserts
 * the row transitions OUT of dead_letter via DB poll. The customer
 * handler is used because under PENNYLANE_DRY_RUN it succeeds
 * deterministically without contacting the Pennylane API.
 *
 * REQUIRES the server to be booted with:
 *   - ENABLE_DEV_LOGIN_FOR_E2E=true   (dev-login backdoor for session)
 *   - PENNYLANE_API_KEY=<anything>    (makes isPennylaneConfigured() true)
 *   - PENNYLANE_PUSH_ENABLED=true     (attemptPennylanePush no-ops otherwise)
 *   - PENNYLANE_DRY_RUN=true          (so the customer handler succeeds
 *                                      without hitting the real API)
 *
 * All seeded rows are deleted in the finally block regardless of
 * pass/fail.
 */

const SEED_PREFIX = "e2e-pennylane-dlq-";

interface Seeded {
  projectId: number;
  pushId: number;
}

interface FeatureFlags {
  configured: boolean;
  pushEnabled: boolean;
  dryRun: boolean;
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function fetchFeatureFlags(api: APIRequestContext): Promise<FeatureFlags> {
  const res = await api.get("/api/pennylane/feature-flags");
  expect(res.ok(), `feature-flags probe failed: ${res.status()}`).toBe(true);
  return (await res.json()) as FeatureFlags;
}

async function seed(db: Client, uniq: string): Promise<Seeded> {
  const projectRes = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name, fee_percentage, client_contact_email)
     VALUES ($1, $2, $3, '10.00', $4)
     RETURNING id`,
    [
      `${SEED_PREFIX}project-${uniq}`,
      `${SEED_PREFIX}${uniq}`,
      "Pennylane DLQ Retry Client",
      `${SEED_PREFIX}${uniq}@local.test`,
    ],
  );
  const projectId = projectRes.rows[0].id;

  // Seed a `customer` push in dead_letter with attempts=5 (the queue's
  // exhaustion ceiling). The customer kind, under PENNYLANE_DRY_RUN,
  // succeeds without any external API call once the retry button
  // resets it to pending and triggers a single attempt.
  const pushRes = await db.query<{ id: number }>(
    `INSERT INTO pennylane_pushes
       (kind, doc_id, project_id, state, attempts, last_error, next_attempt_at)
     VALUES ('customer', $1, $1, 'dead_letter', 5, 'seeded dead-letter for e2e retry', CURRENT_TIMESTAMP)
     RETURNING id`,
    [projectId],
  );
  const pushId = pushRes.rows[0].id;

  return { projectId, pushId };
}

async function cleanup(db: Client, s: Seeded | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM pennylane_pushes WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
  ];
  for (const [sql, params] of stmts) {
    try {
      await db.query(sql, params);
    } catch (err) {
      console.warn("[pennylane-dlq-retry cleanup] swallowed:", (err as Error).message);
    }
  }
}

async function fetchPushState(db: Client, pushId: number): Promise<string | null> {
  const { rows } = await db.query<{ state: string }>(
    `SELECT state FROM pennylane_pushes WHERE id = $1`,
    [pushId],
  );
  return rows[0]?.state ?? null;
}

async function waitForStateChange(
  db: Client,
  pushId: number,
  from: string,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = from;
  while (Date.now() < deadline) {
    last = await fetchPushState(db, pushId);
    if (last && last !== from) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Pennylane push ${pushId} did not leave state '${from}' within ${timeoutMs}ms (last='${last}')`,
  );
}

test.describe("Pennylane — admin DLQ retry flow (task #222)", () => {
  test("clicking Retry on a dead_letter row transitions it out of dead_letter", async ({
    browser,
  }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const email = `e2e-pennylane-dlq-${uniq}@local.test`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    let seeded: Seeded | null = null;
    try {
      // Fail fast if the server isn't running with the dry-run flags
      // armed — without them attemptPennylanePush either no-ops
      // (pushEnabled=false) or tries to hit the real API and re-fails.
      const flags = await fetchFeatureFlags(context.request);
      expect(
        flags.pushEnabled && flags.dryRun && flags.configured,
        `Pennylane feature flags must be configured + pushEnabled + dryRun. Got ${JSON.stringify(flags)}. ` +
          `Set PENNYLANE_API_KEY, PENNYLANE_PUSH_ENABLED=true, PENNYLANE_DRY_RUN=true on the server.`,
      ).toBe(true);

      await devLogin(context.request, email);
      seeded = await seed(db, uniq);

      const page = await context.newPage();
      await page.goto("/admin/ops/pennylane-pushes");

      await expect(page.getByTestId("page-admin-pennylane-pushes")).toBeVisible();

      // Narrow the table to dead_letter so the seeded row is the only
      // candidate and we exercise the state-filter UI explicitly.
      await page.getByTestId("button-filter-state-dead_letter").click();

      const row = page.getByTestId(`row-pennylane-push-${seeded.pushId}`);
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId(`badge-state-${seeded.pushId}`)).toHaveText(/dead_letter/);

      const retryBtn = page.getByTestId(`button-retry-${seeded.pushId}`);
      await expect(retryBtn).toBeVisible();
      await retryBtn.click();

      // Toast confirms the route accepted the retry.
      await expect(
        page.getByText(/Retry triggered/i).first(),
      ).toBeVisible({ timeout: 5_000 });

      // DB poll: the row must leave dead_letter. Under dry-run the
      // customer handler succeeds on the first attempt, so the
      // expected destination is 'succeeded'.
      const finalState = await waitForStateChange(db, seeded.pushId, "dead_letter", 15_000);
      expect(finalState).not.toBe("dead_letter");
      expect(["succeeded", "pending", "in_flight"]).toContain(finalState);

      // Re-render: switching to the matching state filter should now
      // show the row (proves the query-key invalidation worked end-to-
      // end). Generalised across every possible non-dead_letter
      // destination so this assertion always runs.
      await page.getByTestId(`button-filter-state-${finalState}`).click();
      await expect(
        page.getByTestId(`row-pennylane-push-${seeded.pushId}`),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        page.getByTestId(`badge-state-${seeded.pushId}`),
      ).toHaveText(new RegExp(finalState));

      // The dead_letter filter view should no longer include it,
      // regardless of which terminal/intermediate state it landed in.
      await page.getByTestId("button-filter-state-dead_letter").click();
      await expect(
        page.getByTestId(`row-pennylane-push-${seeded.pushId}`),
      ).toHaveCount(0);
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
