import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { createHash, createHmac, randomBytes } from "node:crypto";

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

  // 12. Complete-package PDF endpoint is membership- and token-gated
  //     (happy-path download is skipped: the hermetic server has no real PDF
  //      in object storage — the auth gate is the critical invariant)
  test("package.pdf returns 404 for non-member devis, 404 for revoked token, 410 for expired token", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    let revoked: SeedBase | null = null;
    let expired: SeedBase | null = null;
    try {
      seed = await seedFullFixture(db, uniq);
      revoked = await seedRevokedToken(db, `${uniq}-r`);
      expired = await seedExpiredToken(db, `${uniq}-e`);

      // seedRevokedToken creates no membership row; add one so the 404 below
      // exercises revocation itself, not the membership gate.
      await db.query(
        `INSERT INTO client_project_share_devis (token_id, devis_id) VALUES ($1, $2)`,
        [revoked.tokenId, revoked.devisId],
      );

      const base = `http://localhost:${process.env.PORT ?? 5000}`;

      // Valid token, but devis never published on this link → 404
      const nonMemberResp = await fetch(
        `${base}/p/client/project/${seed.rawTok}/devis/${seed.unpublishedDevisId}/package.pdf`,
      );
      expect(nonMemberResp.status).toBe(404);
      // Must not leak PDF content on the failure path
      expect(nonMemberResp.headers.get("content-type") ?? "").not.toContain("application/pdf");

      // Revoked token → 404 even for its own devis
      const revokedResp = await fetch(
        `${base}/p/client/project/${revoked.rawTok}/devis/${revoked.devisId}/package.pdf`,
      );
      expect(revokedResp.status).toBe(404);

      // Expired token → 410 (devis IS a member on this token; expiry alone blocks it)
      const expiredResp = await fetch(
        `${base}/p/client/project/${expired.rawTok}/devis/${expired.devisId}/package.pdf`,
      );
      expect(expiredResp.status).toBe(410);
    } finally {
      try { await cleanup(db, seed); } catch (_) { /* best-effort */ }
      try { await cleanup(db, revoked); } catch (_) { /* best-effort */ }
      try { await cleanup(db, expired); } finally { await db.end(); }
    }
  });
});

// ---------------------------------------------------------------------------
// Task #404 — architect preview never counts as client activity
// ---------------------------------------------------------------------------

test.describe("ArchiDoc client-link lookup (Task #409)", () => {
  const SECRET = process.env.ARCHIDOC_WEBHOOK_SECRET;

  function signLookup(path: string, ts: number): string {
    return createHmac("sha256", SECRET!).update(`${ts}.GET.${path}`).digest("hex");
  }

  test("signed lookup returns the live URL that resolves publicly; unsigned is rejected", async ({ browser }) => {
    test.skip(!SECRET, "ARCHIDOC_WEBHOOK_SECRET not set in this environment");
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    const ctx = await browser.newContext();
    try {
      seed = await seedFullFixture(db, uniq);
      const archidocId = `${SEED_PREFIX}ad-${uniq}`;
      await db.query(`UPDATE projects SET archidoc_id = $1 WHERE id = $2`, [archidocId, seed.projectId]);
      const path = `/integrations/archidoc/projects/${archidocId}/client-share-link`;

      // Unsigned → 401; bad signature → 401.
      expect((await ctx.request.get(path)).status()).toBe(401);
      expect((await ctx.request.get(path, {
        headers: { "X-Archidoc-Timestamp": String(Date.now()), "X-Archidoc-Signature": "sha256=" + "0".repeat(64) },
      })).status()).toBe(401);

      // Seeded token has no encrypted URL → rotate_required.
      let ts = Date.now();
      const legacyResp = await ctx.request.get(path, {
        headers: { "X-Archidoc-Timestamp": String(ts), "X-Archidoc-Signature": `sha256=${signLookup(path, ts)}` },
      });
      expect(legacyResp.status()).toBe(200);
      expect(await legacyResp.json()).toEqual({ shareUrl: null, reason: "rotate_required" });

      // Rotate via the authenticated API so the encrypted URL exists.
      const loginResp = await ctx.request.post("/api/auth/dev-login", { data: { email: `${SEED_PREFIX}adlookup-${uniq}@local.test` } });
      expect(loginResp.ok()).toBe(true);
      const issueResp = await ctx.request.post(`/api/projects/${seed.projectId}/client-share/issue`, {
        data: { clientEmail: `${SEED_PREFIX}client-${uniq}@local.test`, clientName: "AD Lookup" },
      });
      expect(issueResp.ok()).toBe(true);
      const { shareUrl: issuedUrl } = await issueResp.json();

      // Signed lookup returns the same URL + recipient/expiry.
      ts = Date.now();
      const okResp = await ctx.request.get(path, {
        headers: { "X-Archidoc-Timestamp": String(ts), "X-Archidoc-Signature": `sha256=${signLookup(path, ts)}` },
      });
      expect(okResp.status()).toBe(200);
      const okBody = await okResp.json();
      expect(okBody.shareUrl).toBe(issuedUrl);
      expect(okBody.recipientEmail).toBe(`${SEED_PREFIX}client-${uniq}@local.test`);
      expect(okBody.expiresAt).toBeTruthy();

      // Lookup never mutates the token.
      const { rows: [tok] } = await db.query<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM client_project_share_tokens WHERE project_id = $1 AND revoked_at IS NULL`,
        [seed.projectId],
      );
      expect(tok.last_used_at).toBeNull();

      // Low-noise audit: repeated lookup on the same day adds only ONE entry.
      ts = Date.now();
      await ctx.request.get(path, {
        headers: { "X-Archidoc-Timestamp": String(ts), "X-Archidoc-Signature": `sha256=${signLookup(path, ts)}` },
      });
      const { rows: [auditCount] } = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM client_project_share_audit WHERE project_id = $1 AND action = 'archidoc_lookup'`,
        [seed.projectId],
      );
      expect(auditCount.n).toBe("1");
      // The audit detail never contains the URL/token.
      const { rows: [auditRow] } = await db.query<{ detail: string }>(
        `SELECT detail FROM client_project_share_audit WHERE project_id = $1 AND action = 'archidoc_lookup'`,
        [seed.projectId],
      );
      expect(auditRow.detail).not.toContain(issuedUrl.split("/").pop());

      // The returned URL resolves on the public portal.
      const publicResp = await ctx.request.get(new URL(okBody.shareUrl).pathname);
      expect(publicResp.status()).toBe(200);

      // Unknown ArchiDoc project id → reason unknown_project.
      const unknownPath = `/integrations/archidoc/projects/${SEED_PREFIX}nope-${uniq}/client-share-link`;
      ts = Date.now();
      const unknownResp = await ctx.request.get(unknownPath, {
        headers: { "X-Archidoc-Timestamp": String(ts), "X-Archidoc-Signature": `sha256=${signLookup(unknownPath, ts)}` },
      });
      expect(await unknownResp.json()).toEqual({ shareUrl: null, reason: "unknown_project" });
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); await ctx.close(); }
    }
  });
});

test.describe("Project share link copy (Task #407)", () => {

  async function devLoginCopy(ctx: import("@playwright/test").BrowserContext, email: string) {
    const loginResp = await ctx.request.post("/api/auth/dev-login", { data: { email } });
    expect(loginResp.ok(), `dev-login failed (${loginResp.status()})`).toBe(true);
  }

  test("copy endpoint returns the live URL that resolves publicly; pre-#407 rows get the rotate hint", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    const ctx = await browser.newContext();
    try {
      seed = await seedFullFixture(db, uniq);
      await devLoginCopy(ctx, `${SEED_PREFIX}copy-${uniq}@local.test`);

      // Seeded token was inserted directly (no encrypted URL) — the copy
      // endpoint must refuse with the rotate hint, and state says canCopyLink=false.
      const stateBefore = await (await ctx.request.get(`/api/projects/${seed.projectId}/client-share`)).json();
      expect(stateBefore.canCopyLink).toBe(false);
      const legacy = await ctx.request.get(`/api/projects/${seed.projectId}/client-share/link`);
      expect(legacy.status()).toBe(404);
      expect((await legacy.json()).message).toContain("rotate");

      // Rotate via the API — new token persists the encrypted URL.
      const issueResp = await ctx.request.post(`/api/projects/${seed.projectId}/client-share/issue`, {
        data: { clientEmail: `${SEED_PREFIX}client-${uniq}@local.test`, clientName: "Copy Test" },
      });
      expect(issueResp.ok()).toBe(true);
      const { shareUrl } = await issueResp.json();

      const stateAfter = await (await ctx.request.get(`/api/projects/${seed.projectId}/client-share`)).json();
      expect(stateAfter.canCopyLink).toBe(true);

      // Copy endpoint returns exactly the issued URL...
      const linkResp = await ctx.request.get(`/api/projects/${seed.projectId}/client-share/link`);
      expect(linkResp.ok()).toBe(true);
      const { shareUrl: copied } = await linkResp.json();
      expect(copied).toBe(shareUrl);

      // ...and the URL is never stored in the clear.
      const { rows: [tokRow] } = await db.query<{ encrypted_share_url: string | null }>(
        `SELECT encrypted_share_url FROM client_project_share_tokens
         WHERE project_id = $1 AND revoked_at IS NULL`,
        [seed.projectId],
      );
      expect(tokRow.encrypted_share_url).toBeTruthy();
      expect(tokRow.encrypted_share_url).not.toContain(copied.split("/").pop());

      // Copying must not mutate the token.
      const { rows: [beforeVisit] } = await db.query<{ last_used_at: Date | null; expires_at: Date | null }>(
        `SELECT last_used_at, expires_at FROM client_project_share_tokens
         WHERE project_id = $1 AND revoked_at IS NULL`,
        [seed.projectId],
      );
      expect(beforeVisit.last_used_at).toBeNull();

      // The copied URL resolves on the public route (rotation carried the
      // published devis membership forward).
      const publicResp = await ctx.request.get(copied);
      expect(publicResp.status()).toBe(200);
      const publicPath = new URL(copied).pathname;
      const dataResp = await ctx.request.get(`${publicPath}/data`);
      expect(dataResp.status()).toBe(200);
      const payload = await dataResp.json();
      expect(payload.quotations.map((q: { id: number }) => q.id)).toContain(seed.devisId);

      // Unauthenticated copy is refused by the /api perimeter.
      const anonCtx = await browser.newContext();
      try {
        const anon = await anonCtx.request.get(`/api/projects/${seed.projectId}/client-share/link`);
        expect(anon.status()).toBe(401);
      } finally {
        await anonCtx.close();
      }
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); await ctx.close(); }
    }
  });
});

test.describe("Project share architect preview — no client-activity side effects", () => {

  async function devLogin(ctx: import("@playwright/test").BrowserContext, email: string) {
    const loginResp = await ctx.request.post("/api/auth/dev-login", { data: { email } });
    expect(loginResp.ok(), `dev-login failed (${loginResp.status()})`).toBe(true);
  }

  // 1 + 2 + 3. Preview shell renders with banner, cards link to the architect
  //    per-devis preview, and the token's lastUsedAt / expiresAt stay untouched.
  test("preview shell + data render published quotations without touching lastUsedAt or expiresAt", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    const ctx = await browser.newContext();
    try {
      seed = await seedFullFixture(db, uniq);

      // Pin a known expiry + a known lastUsedAt so "unchanged" is meaningful.
      const pinnedExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      await db.query(
        `UPDATE client_project_share_tokens
         SET expires_at = $2, last_used_at = NULL
         WHERE id = $1`,
        [seed.tokenId, pinnedExpiry],
      );
      const readTok = async () => {
        const { rows } = await db.query<{ last_used_at: Date | null; expires_at: Date | null }>(
          `SELECT last_used_at, expires_at FROM client_project_share_tokens WHERE id = $1`,
          [seed!.tokenId],
        );
        return rows[0];
      };
      const before = await readTok();
      expect(before.last_used_at).toBeNull();

      await devLogin(ctx, `${SEED_PREFIX}arch-${uniq}@local.test`);

      // Preview shell in a real browser page: banner + quotation card visible
      const page = await ctx.newPage();
      const shellResp = await page.goto(`/api/projects/${seed.projectId}/client-share/preview/shell`);
      expect(shellResp?.status()).toBe(200);
      await expect(page.getByTestId("banner-project-share-preview")).toBeVisible({ timeout: 8_000 });
      await expect(page.getByTestId("banner-project-share-preview")).toContainText("Architect preview");

      const card = page.getByTestId(`card-quotation-${SEED_PREFIX}D1-${uniq}`);
      await expect(card).toBeVisible();
      // Card links to the per-devis ARCHITECT preview shell, never a token URL
      const href = await card.getAttribute("href");
      expect(href).toBe(
        `/api/devis/${seed.devisId}/client-checks/portal-preview/shell?projectId=${seed.projectId}`,
      );
      expect(href).not.toContain("/p/client/");
      expect(href).not.toContain(seed.rawTok);

      // Unpublished / untranslated devis absent from the preview too
      await expect(page.getByTestId(`card-quotation-${SEED_PREFIX}D2-${uniq}`)).not.toBeVisible();
      await expect(page.getByTestId(`card-quotation-${SEED_PREFIX}D3-${uniq}`)).not.toBeVisible();

      // Preview data endpoint mirrors the client payload (whitelist shape)
      const dataResp = await ctx.request.get(`/api/projects/${seed.projectId}/client-share/preview/data`);
      expect(dataResp.ok(), `preview data failed (${dataResp.status()})`).toBe(true);
      const body = await dataResp.json();
      expect(body.quotations).toHaveLength(1);
      expect(body.quotations[0].id).toBe(seed.devisId);
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("iban");
      expect(raw).not.toContain("aiExtractedData");
      expect(raw).not.toContain("validationWarnings");

      // THE invariant: after shell + data, the token is completely untouched.
      const after = await readTok();
      expect(after.last_used_at).toBeNull();
      expect(after.expires_at?.toISOString()).toBe(new Date(pinnedExpiry).toISOString());

      // Control: a LIVE client visit still counts as activity.
      const liveResp = await ctx.request.get(`/p/client/project/${seed.rawTok}/data`);
      expect(liveResp.ok()).toBe(true);
      const afterLive = await readTok();
      expect(afterLive.last_used_at).not.toBeNull();
      // Sliding expiry refreshed — strictly later than the pinned value
      expect(afterLive.expires_at!.getTime()).toBeGreaterThan(new Date(pinnedExpiry).getTime());
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); await ctx.close(); }
    }
  });

  // 4. No active link → accurate empty state (no invented data)
  test("preview shows empty state when the project has no active link", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let projectId: number | null = null;
    const ctx = await browser.newContext();
    try {
      const { rows: [proj] } = await db.query<{ id: number }>(
        `INSERT INTO projects (name, code, client_name)
         VALUES ($1, $2, $3) RETURNING id`,
        [`${SEED_PREFIX}nolink-${uniq}`, `${SEED_PREFIX}nl-${uniq}`, "No Link"],
      );
      projectId = proj.id;

      await devLogin(ctx, `${SEED_PREFIX}arch2-${uniq}@local.test`);

      const dataResp = await ctx.request.get(`/api/projects/${projectId}/client-share/preview/data`);
      expect(dataResp.ok()).toBe(true);
      const body = await dataResp.json();
      expect(body.quotations).toEqual([]);

      const page = await ctx.newPage();
      await page.goto(`/api/projects/${projectId}/client-share/preview/shell`);
      await expect(page.getByTestId("banner-project-share-preview")).toBeVisible({ timeout: 8_000 });
      await expect(page.getByTestId("text-no-quotations")).toBeVisible();
    } finally {
      try {
        if (projectId !== null) await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
      } catch (_) { /* best-effort */ }
      await db.end();
      await ctx.close();
    }
  });

  // 5. Both preview endpoints sit behind the /api auth perimeter
  test("unauthenticated requests to preview shell and data get 401", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: SeedFull | null = null;
    const ctx = await browser.newContext(); // fresh context = no session
    try {
      seed = await seedFullFixture(db, uniq);

      const shellResp = await ctx.request.get(
        `/api/projects/${seed.projectId}/client-share/preview/shell`,
      );
      expect(shellResp.status()).toBe(401);

      const dataResp = await ctx.request.get(
        `/api/projects/${seed.projectId}/client-share/preview/data`,
      );
      expect(dataResp.status()).toBe(401);

      // And an unauthenticated preview attempt leaves the token untouched too
      const { rows } = await db.query<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM client_project_share_tokens WHERE id = $1`,
        [seed.tokenId],
      );
      expect(rows[0].last_used_at).toBeNull();
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); await ctx.close(); }
    }
  });
});
