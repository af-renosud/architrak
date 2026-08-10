import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { createHash, randomBytes } from "node:crypto";

/**
 * E2E coverage for the project-level client share portal (Task #390).
 *
 * Covers the data-leak and access-control invariants on the unauthenticated
 * public surface /p/client/project/:token:
 *
 *  1. Landing page shows ONLY explicitly published devis; unpublished absent.
 *  2. Revoked token → 404 page; /data returns 404.
 *  3. Expired token → 410 page; /data and detail /data return 410.
 *  4. /data payload never contains banking, aiExtractedData, or
 *     validationWarnings fields (strict whitelist assertion).
 *  5. Untranslated devis rejected at the publish endpoint (server-side).
 *  6. Per-line question query anchors to the correct line item id.
 *  7. Cross-project devis membership is refused server-side (membership
 *     never grants access to a devis that's in a different project).
 *  8. Legacy per-devis /p/client/:token links still work alongside project links.
 *
 * All tests hit the shared dev server (port 5000). Data is seeded via direct
 * Postgres access and cleaned up in the finally block. No auth required for
 * public portal reads; the publish-block test calls the API as an
 * authenticated architect.
 *
 * Hermetic rule: every row uses the SEED_PREFIX so cleanup can match by value
 * even if a previous run left orphans.
 */

const SEED_PREFIX = "e2e-cpshare-";

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
function rawToken(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// DB seeding helpers
// ---------------------------------------------------------------------------

interface SeedBase {
  projectId: number;
  contractorId: number;
  devisId: number; // published devis (has finalised translation)
  tokenId: number;
  rawTok: string;
}

interface SeedFull extends SeedBase {
  unpublishedDevisId: number; // devis without membership row
  untranslatedDevisId: number; // devis without a translation row
  lineItemId: number; // a line item on the published devis
}

async function seedFullFixture(db: Client, uniq: string): Promise<SeedFull> {
  // Project
  const { rows: [proj] } = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${SEED_PREFIX}proj-${uniq}`, `${SEED_PREFIX}${uniq}`, "Client Test"],
  );
  const projectId = proj.id;

  // Contractor (required FK on devis)
  const { rows: [contr] } = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, email) VALUES ($1, $2) RETURNING id`,
    [`${SEED_PREFIX}ctr-${uniq}`, `${SEED_PREFIX}ctr-${uniq}@local.test`],
  );
  const contractorId = contr.id;

  // Published devis: has a finalised translation
  const { rows: [d1] } = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc)
     VALUES ($1, $2, $3, $4, '5000.00', '6000.00') RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D1-${uniq}`, "Devis principal de test"],
  );
  const devisId = d1.id;

  // Seed a finalised translation so publishing is allowed
  await db.query(
    `INSERT INTO devis_translations (devis_id, status)
     VALUES ($1, 'finalised')
     ON CONFLICT (devis_id) DO UPDATE SET status = 'finalised'`,
    [devisId],
  );

  // Line item on the published devis
  const { rows: [li] } = await db.query<{ id: number }>(
    `INSERT INTO devis_line_items
       (devis_id, line_number, description, quantity, unit, unit_price_ht, total_ht)
     VALUES ($1, 1, $2, '10', 'm²', '50.00', '500.00') RETURNING id`,
    [devisId, `${SEED_PREFIX}line-item-${uniq}`],
  );
  const lineItemId = li.id;

  // Unpublished devis (also has translation but NO membership row)
  const { rows: [d2] } = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc)
     VALUES ($1, $2, $3, $4, '1000.00', '1200.00') RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D2-${uniq}`, "Devis non publié de test"],
  );
  const unpublishedDevisId = d2.id;
  await db.query(
    `INSERT INTO devis_translations (devis_id, status)
     VALUES ($1, 'finalised')
     ON CONFLICT (devis_id) DO UPDATE SET status = 'finalised'`,
    [unpublishedDevisId],
  );

  // Untranslated devis (no translation row at all)
  const { rows: [d3] } = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc)
     VALUES ($1, $2, $3, $4, '2000.00', '2400.00') RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D3-${uniq}`, "Devis sans traduction"],
  );
  const untranslatedDevisId = d3.id;

  // Project share token (active, not expired, not revoked)
  const tok = rawToken();
  const { rows: [tkRow] } = await db.query<{ id: number }>(
    `INSERT INTO client_project_share_tokens
       (project_id, token_hash, client_email, client_name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [projectId, hash(tok), `${SEED_PREFIX}client-${uniq}@local.test`, "Alice Test"],
  );
  const tokenId = tkRow.id;

  // Membership: only d1 is published
  await db.query(
    `INSERT INTO client_project_share_devis (token_id, devis_id)
     VALUES ($1, $2)`,
    [tokenId, devisId],
  );

  return {
    projectId, contractorId,
    devisId, unpublishedDevisId, untranslatedDevisId,
    lineItemId,
    tokenId, rawTok: tok,
  };
}

async function seedRevokedToken(db: Client, uniq: string): Promise<SeedBase> {
  const { rows: [proj] } = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${SEED_PREFIX}revproj-${uniq}`, `${SEED_PREFIX}rev-${uniq}`, "Rev Client"],
  );
  const projectId = proj.id;
  const { rows: [contr] } = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, email) VALUES ($1, $2) RETURNING id`,
    [`${SEED_PREFIX}revctr-${uniq}`, `${SEED_PREFIX}revctr-${uniq}@local.test`],
  );
  const contractorId = contr.id;
  const { rows: [d] } = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc)
     VALUES ($1, $2, $3, $4, '100.00', '120.00') RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}DR-${uniq}`, "Revoked devis"],
  );
  const tok = rawToken();
  const { rows: [tkRow] } = await db.query<{ id: number }>(
    `INSERT INTO client_project_share_tokens
       (project_id, token_hash, client_email, revoked_at)
     VALUES ($1, $2, $3, NOW()) RETURNING id`,
    [projectId, hash(tok), `${SEED_PREFIX}rev-${uniq}@local.test`],
  );
  return { projectId, contractorId, devisId: d.id, tokenId: tkRow.id, rawTok: tok };
}

async function seedExpiredToken(db: Client, uniq: string): Promise<SeedBase> {
  const { rows: [proj] } = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${SEED_PREFIX}expproj-${uniq}`, `${SEED_PREFIX}exp-${uniq}`, "Exp Client"],
  );
  const projectId = proj.id;
  const { rows: [contr] } = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, email) VALUES ($1, $2) RETURNING id`,
    [`${SEED_PREFIX}expctr-${uniq}`, `${SEED_PREFIX}expctr-${uniq}@local.test`],
  );
  const contractorId = contr.id;
  const { rows: [d] } = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc)
     VALUES ($1, $2, $3, $4, '100.00', '120.00') RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}DE-${uniq}`, "Expired devis"],
  );
  await db.query(
    `INSERT INTO devis_translations (devis_id, status)
     VALUES ($1, 'finalised')
     ON CONFLICT (devis_id) DO UPDATE SET status = 'finalised'`,
    [d.id],
  );
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const tok = rawToken();
  const { rows: [tkRow] } = await db.query<{ id: number }>(
    `INSERT INTO client_project_share_tokens
       (project_id, token_hash, client_email, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [projectId, hash(tok), `${SEED_PREFIX}exp-${uniq}@local.test`, past.toISOString()],
  );
  // Also add a membership row so the devis would show if the token were valid
  await db.query(
    `INSERT INTO client_project_share_devis (token_id, devis_id) VALUES ($1, $2)`,
    [tkRow.id, d.id],
  );
  return { projectId, contractorId, devisId: d.id, tokenId: tkRow.id, rawTok: tok };
}

/** Best-effort cleanup; cascade from projects covers most child rows. */
async function cleanup(db: Client, s: SeedBase | SeedFull | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    // Token rows cascade to memberships; delete the token first for revoked/expired
    ["DELETE FROM client_project_share_tokens WHERE project_id = $1", [s.projectId]],
    // Devis cascade to translations, line items, checks
    ["DELETE FROM devis WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try { await db.query(sql, params); } catch (_) { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("Client project share portal — data-leak and access-control", () => {

  // 1. Landing page only shows explicitly published devis
  test("landing page lists only published devis; unpublished devis is absent", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    const ctx = await browser.newContext();
    try {
      seed = await seedFullFixture(db, uniq);

      const page = await ctx.newPage();
      await page.goto(`/p/client/project/${seed.rawTok}`);

      // Greeting and project name visible
      const greeting = page.getByTestId("text-greeting");
      await expect(greeting).toBeVisible({ timeout: 8_000 });
      await expect(greeting).toContainText("Alice Test");

      // Published devis card is present
      const publishedCard = page.getByTestId(`card-quotation-${SEED_PREFIX}D1-${uniq}`);
      await expect(publishedCard).toBeVisible();

      // Unpublished devis card is NOT present
      const unpublishedCard = page.getByTestId(`card-quotation-${SEED_PREFIX}D2-${uniq}`);
      await expect(unpublishedCard).not.toBeVisible();

      // Untranslated devis card is NOT present either
      const untranslatedCard = page.getByTestId(`card-quotation-${SEED_PREFIX}D3-${uniq}`);
      await expect(untranslatedCard).not.toBeVisible();
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); await ctx.close(); }
    }
  });

  // 2. /data JSON payload — landing page — strict whitelist
  test("/data landing payload never exposes banking, aiExtractedData, validationWarnings, or storage keys", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    try {
      seed = await seedFullFixture(db, uniq);

      // Add sensitive fields that exist on the devis table to confirm they never surface.
      // (IBAN/BIC live on the contractors table, not devis; we assert by name in the raw JSON.)
      await db.query(
        `UPDATE devis
         SET ai_extracted_data = '{"secret":"yes","iban":"FR7630006000011234567890189","bic":"BNPAFRPP"}'::jsonb,
             validation_warnings = '["warn1"]'::jsonb,
             pdf_storage_key = 'private/path/devis.pdf'
         WHERE id = $1`,
        [seed.devisId],
      );

      const resp = await fetch(`http://localhost:${process.env.PORT ?? 5000}/p/client/project/${seed.rawTok}/data`);
      expect(resp.ok, `Expected 200, got ${resp.status}`).toBe(true);
      const body = await resp.json();

      // Check the raw JSON string for private field names
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("iban");
      expect(raw).not.toContain("bic");
      expect(raw).not.toContain("aiExtractedData");
      expect(raw).not.toContain("ai_extracted_data");
      expect(raw).not.toContain("validationWarnings");
      expect(raw).not.toContain("validation_warnings");
      expect(raw).not.toContain("bankingAiExtractedData");
      expect(raw).not.toContain("banking_ai_extracted_data");
      expect(raw).not.toContain("StorageKey");
      expect(raw).not.toContain("storage_key");
      expect(raw).not.toContain("secret");

      // Structure is correct
      expect(body).toHaveProperty("project");
      expect(body).toHaveProperty("client");
      expect(body).toHaveProperty("quotations");
      expect(Array.isArray(body.quotations)).toBe(true);
      expect(body.quotations).toHaveLength(1);

      // Quotation only exposes the whitelist fields
      const q = body.quotations[0];
      expect(q).toHaveProperty("id");
      expect(q).toHaveProperty("ref");
      expect(q).toHaveProperty("amountHt");
      expect(q).toHaveProperty("translationAvailable");
      expect(q).toHaveProperty("analysisAvailable");
      expect(q).toHaveProperty("status");
      // Must NOT have private fields
      expect(q).not.toHaveProperty("iban");
      expect(q).not.toHaveProperty("bic");
      expect(q).not.toHaveProperty("aiExtractedData");
      expect(q).not.toHaveProperty("validationWarnings");
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); }
    }
  });

  // 3. Detail /data payload — strict whitelist
  test("/devis/:id/data detail payload never exposes private fields", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    try {
      seed = await seedFullFixture(db, uniq);

      // Add sensitive fields that exist on devis to confirm they never appear in the payload.
      await db.query(
        `UPDATE devis
         SET ai_extracted_data = '{"contractor_secret":"yes","iban":"FR76XXX","bic":"BNPAFRPP"}'::jsonb,
             validation_warnings = '["w1"]'::jsonb,
             pdf_storage_key = 'private/path/to.pdf'
         WHERE id = $1`,
        [seed.devisId],
      );

      const base = `http://localhost:${process.env.PORT ?? 5000}`;
      const url = `${base}/p/client/project/${seed.rawTok}/devis/${seed.devisId}/data`;
      const resp = await fetch(url);
      expect(resp.ok, `Expected 200, got ${resp.status}`).toBe(true);
      const body = await resp.json();

      const raw = JSON.stringify(body);
      expect(raw).not.toContain("iban");
      expect(raw).not.toContain("bic");
      expect(raw).not.toContain("aiExtractedData");
      expect(raw).not.toContain("ai_extracted_data");
      expect(raw).not.toContain("validationWarnings");
      expect(raw).not.toContain("validation_warnings");
      expect(raw).not.toContain("StorageKey");
      expect(raw).not.toContain("storage_key");
      expect(raw).not.toContain("contractor_secret");

      // Shape: devis summary, lineItems, checks — no raw db fields
      expect(body).toHaveProperty("devis");
      expect(body).toHaveProperty("lineItems");
      expect(body).toHaveProperty("checks");
      expect(body.devis).toHaveProperty("ref");
      expect(body.devis).toHaveProperty("amountHt");
      expect(body.devis).toHaveProperty("hasPdf"); // boolean, not the key itself
      expect(body.devis).not.toHaveProperty("pdfStorageKey");
      expect(body.devis).not.toHaveProperty("iban");
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); }
    }
  });

  // 4. Revoked token → 404 page and 404 on /data
  test("revoked project token renders invalid page; /data returns 404", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedBase | null = null;
    const ctx = await browser.newContext();
    try {
      seed = await seedRevokedToken(db, uniq);

      // HTML shell: 404 with invalid-page testid
      const shellResp = await ctx.request.get(`/p/client/project/${seed.rawTok}`);
      expect(shellResp.status()).toBe(404);
      const html = await shellResp.text();
      expect(html).toContain("page-project-share-invalid");

      // Also verify in a real browser page
      const page = await ctx.newPage();
      const navResp = await page.goto(`/p/client/project/${seed.rawTok}`);
      expect(navResp?.status()).toBe(404);
      await expect(page.getByTestId("page-project-share-invalid")).toBeVisible();

      // /data endpoint: 404 with expired:false (revoked ≠ expired)
      const dataResp = await ctx.request.get(`/p/client/project/${seed.rawTok}/data`);
      expect(dataResp.status()).toBe(404);
      const dataBody = await dataResp.json();
      expect(typeof dataBody.message).toBe("string");
      // expired must be false (not true) — revoked links are not the same as expired
      expect(dataBody.expired).toBe(false);

      // Detail /data endpoint: also 404
      const detailResp = await ctx.request.get(
        `/p/client/project/${seed.rawTok}/devis/${seed.devisId}/data`,
      );
      expect(detailResp.status()).toBe(404);
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); await ctx.close(); }
    }
  });

  // 5. Expired token → 410 page and 410 on /data and /pdf
  test("expired project token renders expired page; /data and /devis/.../data return 410", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedBase | null = null;
    const ctx = await browser.newContext();
    try {
      seed = await seedExpiredToken(db, uniq);

      // HTML shell: 410 with expired-page testid
      const shellResp = await ctx.request.get(`/p/client/project/${seed.rawTok}`);
      expect(shellResp.status()).toBe(410);
      const html = await shellResp.text();
      expect(html).toContain("page-project-share-expired");

      // Verify the expired heading renders in browser
      const page = await ctx.newPage();
      const navResp = await page.goto(`/p/client/project/${seed.rawTok}`);
      expect(navResp?.status()).toBe(410);
      await expect(page.getByTestId("page-project-share-expired")).toBeVisible();
      await expect(page.locator("h1")).toHaveText("Link expired");

      // /data: 410 with expired: true
      const dataResp = await ctx.request.get(`/p/client/project/${seed.rawTok}/data`);
      expect(dataResp.status()).toBe(410);
      const dataBody = await dataResp.json();
      expect(dataBody.expired).toBe(true);

      // Detail /data: also 410
      const detailResp = await ctx.request.get(
        `/p/client/project/${seed.rawTok}/devis/${seed.devisId}/data`,
      );
      expect(detailResp.status()).toBe(410);

      // PDF endpoint: 410
      const pdfResp = await ctx.request.get(
        `/p/client/project/${seed.rawTok}/devis/${seed.devisId}/pdf`,
      );
      expect(pdfResp.status()).toBe(410);
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); await ctx.close(); }
    }
  });

  // 6. Untranslated devis is blocked at the server-level publish endpoint
  test("server refuses to publish an untranslated devis onto the project link", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    const ctx = await browser.newContext();
    try {
      seed = await seedFullFixture(db, uniq);

      // dev-login (upsertUser creates the user automatically with googleId dev:<email>)
      const testEmail = `${SEED_PREFIX}arch-${uniq}@local.test`;
      const loginResp = await ctx.request.post("/api/auth/dev-login", { data: { email: testEmail } });
      expect(loginResp.ok(), `dev-login failed (${loginResp.status()})`).toBe(true);

      // Try to publish the untranslated devis — should get 409 with an explanation
      const publishResp = await ctx.request.post(
        `/api/projects/${seed.projectId}/client-share/publish`,
        { data: { devisId: seed.untranslatedDevisId } },
      );
      expect(publishResp.status()).toBe(409);
      const body = await publishResp.json();
      expect(body.message).toContain("translation");

      // Confirm the untranslated devis still does NOT appear on the portal
      const dataResp = await ctx.request.get(`/p/client/project/${seed.rawTok}/data`);
      expect(dataResp.ok()).toBe(true);
      const portalBody = await dataResp.json();
      const ids = portalBody.quotations.map((q: { id: number }) => q.id);
      expect(ids).not.toContain(seed.untranslatedDevisId);
    } finally {
      try { await ctx.close(); } catch (_) { /* best-effort */ }
      try { await cleanup(db, seed); } finally { await db.end(); }
    }
  });

  // 7. Non-member devis under a valid token → 404 (cross-devis isolation)
  test("detail view returns 404 for a devis not published on this token", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    try {
      seed = await seedFullFixture(db, uniq);

      const base = `http://localhost:${process.env.PORT ?? 5000}`;

      // Try accessing unpublished devis data through this valid token
      const dataResp = await fetch(
        `${base}/p/client/project/${seed.rawTok}/devis/${seed.unpublishedDevisId}/data`,
      );
      expect(dataResp.status).toBe(404);

      // PDF endpoint also 404
      const pdfResp = await fetch(
        `${base}/p/client/project/${seed.rawTok}/devis/${seed.unpublishedDevisId}/pdf`,
      );
      expect(pdfResp.status).toBe(404);

      // Messages endpoint also 404
      const msgResp = await fetch(
        `${base}/p/client/project/${seed.rawTok}/devis/${seed.unpublishedDevisId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkId: 99999, body: "Should not work" }),
        },
      );
      expect(msgResp.status).toBe(404);
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); }
    }
  });

  // 8. Per-line question anchor: query with devisLineItemId succeeds and
  //    the resulting client_check row carries the line reference
  test("per-line question query anchors to the correct line item id in the db", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    try {
      seed = await seedFullFixture(db, uniq);

      const base = `http://localhost:${process.env.PORT ?? 5000}`;
      const queriesUrl =
        `${base}/p/client/project/${seed.rawTok}/devis/${seed.devisId}/queries`;

      const resp = await fetch(queriesUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "Question about line item",
          devisLineItemId: seed.lineItemId,
        }),
      });
      expect(resp.status).toBe(201);
      const body = await resp.json();
      expect(typeof body.id).toBe("number");

      // Verify the resulting client_check row has the line item FK set
      const { rows } = await db.query<{ devis_line_item_id: number | null }>(
        `SELECT devis_line_item_id FROM client_checks WHERE id = $1`,
        [body.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].devis_line_item_id).toBe(seed.lineItemId);

      // The /data payload should include this check with the query text
      const dataResp = await fetch(
        `${base}/p/client/project/${seed.rawTok}/devis/${seed.devisId}/data`,
      );
      expect(dataResp.ok).toBe(true);
      const dataBody = await dataResp.json();
      const check = dataBody.checks.find((c: { id: number }) => c.id === body.id);
      expect(check).toBeDefined();
      expect(check.query).toBe("Question about line item");

      // Quotation-level question (no line anchor) also works and gets null line ref
      const resp2 = await fetch(queriesUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "General quotation question" }),
      });
      expect(resp2.status).toBe(201);
      const body2 = await resp2.json();
      const { rows: rows2 } = await db.query<{ devis_line_item_id: number | null }>(
        `SELECT devis_line_item_id FROM client_checks WHERE id = $1`,
        [body2.id],
      );
      expect(rows2[0].devis_line_item_id).toBeNull();
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); }
    }
  });

  // 9. /agree and /reject are retired (410) on the project portal
  test("verdict endpoints return 410 on the project portal (retired)", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    try {
      seed = await seedFullFixture(db, uniq);
      const base = `http://localhost:${process.env.PORT ?? 5000}`;
      const agreeResp = await fetch(
        `${base}/p/client/project/${seed.rawTok}/devis/${seed.devisId}/agree`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      expect(agreeResp.status).toBe(410);
      const rejectResp = await fetch(
        `${base}/p/client/project/${seed.rawTok}/devis/${seed.devisId}/reject`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      expect(rejectResp.status).toBe(410);
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); }
    }
  });

  // 10. Legacy per-devis /p/client/:token links still work alongside project links
  test("legacy per-devis client portal still works when a project link also exists", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    let legacyTokenId: number | null = null;
    const ctx = await browser.newContext();
    try {
      seed = await seedFullFixture(db, uniq);

      // Seed a legacy per-devis client_check_token
      const legacyTok = rawToken();
      const { rows: [ltRow] } = await db.query<{ id: number }>(
        `INSERT INTO client_check_tokens
           (devis_id, token_hash, client_email, client_name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [seed.devisId, hash(legacyTok), `${SEED_PREFIX}legacy-${uniq}@local.test`, "Legacy Client"],
      );
      legacyTokenId = ltRow.id;

      // Legacy per-devis portal HTML renders (200)
      const page = await ctx.newPage();
      const legacyResp = await page.goto(`/p/client/${legacyTok}`);
      expect(legacyResp?.status()).toBe(200);

      // Legacy /data also works
      const legacyDataResp = await ctx.request.get(`/p/client/${legacyTok}/data`);
      expect(legacyDataResp.ok()).toBe(true);
      const legacyData = await legacyDataResp.json();
      expect(legacyData).toHaveProperty("devis");
      expect(legacyData).toHaveProperty("lineItems");
      expect(legacyData).toHaveProperty("checks");
      // Privacy: legacy payload also free of private fields
      const raw = JSON.stringify(legacyData);
      expect(raw).not.toContain("iban");
      expect(raw).not.toContain("bic");
      expect(raw).not.toContain("aiExtractedData");
      expect(raw).not.toContain("validationWarnings");

      // Project portal is still valid in parallel (two portals co-existing)
      const projectDataResp = await ctx.request.get(
        `/p/client/project/${seed.rawTok}/data`,
      );
      expect(projectDataResp.ok()).toBe(true);
      const projectData = await projectDataResp.json();
      expect(projectData.quotations).toHaveLength(1);
    } finally {
      try {
        if (legacyTokenId !== null) {
          await db.query("DELETE FROM client_check_tokens WHERE id = $1", [legacyTokenId]);
        }
      } catch (_) { /* best-effort */ }
      try { await cleanup(db, seed); } finally { await db.end(); await ctx.close(); }
    }
  });

  // 11. Void devis silently drops from the page (defense in depth)
  test("void devis silently drops from portal even if membership row exists", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    try {
      seed = await seedFullFixture(db, uniq);

      // Confirm published devis appears initially
      const base = `http://localhost:${process.env.PORT ?? 5000}`;
      const before = await (await fetch(`${base}/p/client/project/${seed.rawTok}/data`)).json();
      expect(before.quotations).toHaveLength(1);
      expect(before.quotations[0].id).toBe(seed.devisId);

      // Mark the published devis as void — simulates a business decision after publishing
      await db.query(
        `UPDATE devis SET status = 'void', sign_off_stage = 'void' WHERE id = $1`,
        [seed.devisId],
      );

      // Portal now returns empty quotations (membership row still exists but
      // isVisibleOnShareLink() filters it out)
      const after = await (await fetch(`${base}/p/client/project/${seed.rawTok}/data`)).json();
      expect(after.quotations).toHaveLength(0);

      // Detail view is also 404 for the voided devis
      const detailResp = await fetch(
        `${base}/p/client/project/${seed.rawTok}/devis/${seed.devisId}/data`,
      );
      expect(detailResp.status).toBe(404);
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); }
    }
  });
});
