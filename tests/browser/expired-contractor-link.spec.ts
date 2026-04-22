import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { createHash, randomBytes } from "node:crypto";

/**
 * E2E coverage for the contractor question portal expired-link experience
 * (task #88).
 *
 * Seeds a minimal project + contractor + devis + devis_check_tokens row
 * with `expires_at` set to a past timestamp, then asserts that:
 *   - GET /p/check/:token returns HTTP 410 with HTML containing
 *     "Lien expiré" (the server uses 410 Gone for the expired shell;
 *     we assert both the status and the rendered French page).
 *   - GET /p/check/:token/data returns 410 with `expired: true` JSON.
 *
 * The token is inserted directly via pg because there is no public API
 * for forcing a past expiry — the issue path always computes the expiry
 * from the configured TTL.
 */

const SEED_PREFIX = "e2e-expired-link-";

interface Seeded {
  rawToken: string;
  tokenId: number;
  devisId: number;
  contractorId: number;
  projectId: number;
}

async function seedExpiredToken(db: Client, uniq: string): Promise<Seeded> {
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

  const devisRes = await db.query<{ id: number }>(
    `INSERT INTO devis (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D-${uniq}`, "Devis de test expiration", "100.00", "120.00"],
  );
  const devisId = devisRes.rows[0].id;

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
  const tokenRes = await db.query<{ id: number }>(
    `INSERT INTO devis_check_tokens
       (devis_id, token_hash, contractor_id, contractor_email, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [devisId, tokenHash, contractorId, `${SEED_PREFIX}${uniq}@local.test`, past.toISOString()],
  );

  return { rawToken, tokenId: tokenRes.rows[0].id, devisId, contractorId, projectId };
}

async function cleanupSeed(db: Client, s: Seeded | null): Promise<void> {
  if (!s) return;
  // Cascades from projects -> devis -> devis_check_tokens; clean contractors
  // separately because they're not project-scoped.
  await db.query("DELETE FROM devis_check_tokens WHERE id = $1", [s.tokenId]);
  await db.query("DELETE FROM devis WHERE id = $1", [s.devisId]);
  await db.query("DELETE FROM projects WHERE id = $1", [s.projectId]);
  await db.query("DELETE FROM contractors WHERE id = $1", [s.contractorId]);
}

test.describe("Contractor portal — expired link", () => {
  test("shows 'Lien expiré' page and returns 410 from /data", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set for this test").toBeTruthy();

    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();

    let seeded: Seeded | null = null;
    const context = await browser.newContext();
    try {
      seeded = await seedExpiredToken(db, uniq);

      // ---- Page: /p/check/:token returns 410 + "Lien expiré" HTML ----
      const pageUrl = `/p/check/${seeded.rawToken}`;
      const apiRes = await context.request.get(pageUrl);
      expect(apiRes.status()).toBe(410);
      const html = await apiRes.text();
      expect(html).toContain("Lien expiré");

      // Also load it in a real browser tab and assert the dedicated
      // testid + the visible French heading render.
      const page = await context.newPage();
      const navResp = await page.goto(pageUrl);
      expect(navResp?.status()).toBe(410);
      await expect(page.getByTestId("page-expired")).toBeVisible();
      await expect(page.locator("h1")).toHaveText("Lien expiré");

      // ---- JSON: /p/check/:token/data returns 410 + { expired: true } ----
      const dataRes = await context.request.get(`/p/check/${seeded.rawToken}/data`);
      expect(dataRes.status()).toBe(410);
      const body = await dataRes.json();
      expect(body.expired).toBe(true);
      expect(typeof body.message).toBe("string");
      expect(body.message).toContain("Lien expiré");
    } finally {
      try {
        await cleanupSeed(db, seeded);
      } finally {
        await db.end();
        await context.close();
      }
    }
  });
});
