import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { createHash, randomBytes } from "node:crypto";

/**
 * E2E coverage for project share link rotation (Task #399).
 *
 * When the architect calls POST /api/projects/:id/client-share/issue a
 * second time, the link rotates. Invariants under test:
 *
 *  1. The OLD raw token becomes immediately unreachable — HTML shell and
 *     /data both return 404 (revoked, not expired).
 *  2. The NEW token works: landing page and /data return the published devis.
 *  3. Publish memberships carry forward — the devis published on the old
 *     token appears exactly ONCE under the new token (no duplication, no
 *     silent unpublish), and the DB has exactly one membership row for the
 *     new token.
 *
 * Seeding mirrors client-project-share-portal.spec.ts: direct Postgres
 * inserts with a hermetic SEED_PREFIX, cleanup in finally. Rotation is done
 * through the real API as an authenticated architect (dev-login).
 */

const SEED_PREFIX = "e2e-cpshare-rot-";

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
function rawToken(): string {
  return randomBytes(32).toString("base64url");
}

interface Seed {
  projectId: number;
  contractorId: number;
  devisId: number;
  tokenId: number;
  rawTok: string;
}

async function seedActiveTokenWithPublishedDevis(db: Client, uniq: string): Promise<Seed> {
  const { rows: [proj] } = await db.query<{ id: number }>(
    `INSERT INTO projects (name, code, client_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${SEED_PREFIX}proj-${uniq}`, `${SEED_PREFIX}${uniq}`, "Rotation Client"],
  );
  const projectId = proj.id;

  const { rows: [contr] } = await db.query<{ id: number }>(
    `INSERT INTO contractors (name, email) VALUES ($1, $2) RETURNING id`,
    [`${SEED_PREFIX}ctr-${uniq}`, `${SEED_PREFIX}ctr-${uniq}@local.test`],
  );
  const contractorId = contr.id;

  const { rows: [d] } = await db.query<{ id: number }>(
    `INSERT INTO devis
       (project_id, contractor_id, devis_code, description_fr, amount_ht, amount_ttc)
     VALUES ($1, $2, $3, $4, '5000.00', '6000.00') RETURNING id`,
    [projectId, contractorId, `${SEED_PREFIX}D1-${uniq}`, "Devis rotation test"],
  );
  const devisId = d.id;

  await db.query(
    `INSERT INTO devis_translations (devis_id, status)
     VALUES ($1, 'finalised')
     ON CONFLICT (devis_id) DO UPDATE SET status = 'finalised'`,
    [devisId],
  );

  const tok = rawToken();
  const { rows: [tkRow] } = await db.query<{ id: number }>(
    `INSERT INTO client_project_share_tokens
       (project_id, token_hash, client_email, client_name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [projectId, hash(tok), `${SEED_PREFIX}client-${uniq}@local.test`, "Old Client"],
  );
  const tokenId = tkRow.id;

  await db.query(
    `INSERT INTO client_project_share_devis (token_id, devis_id) VALUES ($1, $2)`,
    [tokenId, devisId],
  );

  return { projectId, contractorId, devisId, tokenId, rawTok: tok };
}

async function cleanup(db: Client, s: Seed | null) {
  if (!s) return;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM client_project_share_tokens WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM devis WHERE project_id = $1", [s.projectId]],
    ["DELETE FROM projects WHERE id = $1", [s.projectId]],
    ["DELETE FROM contractors WHERE id = $1", [s.contractorId]],
  ];
  for (const [sql, params] of stmts) {
    try { await db.query(sql, params); } catch (_) { /* best-effort */ }
  }
}

test.describe("Project share link rotation — old token dies, memberships carry", () => {
  test("rotation kills the old token immediately and carries the published devis exactly once", async ({ browser }) => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set").toBeTruthy();

    const uniq = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const db = new Client({ connectionString: databaseUrl! });
    await db.connect();
    let seed: Seed | null = null;
    const ctx = await browser.newContext();
    try {
      seed = await seedActiveTokenWithPublishedDevis(db, uniq);

      // Sanity: the OLD token works before rotation.
      const preResp = await ctx.request.get(`/p/client/project/${seed.rawTok}/data`);
      expect(preResp.status(), "old token should work before rotation").toBe(200);
      const preBody = await preResp.json();
      expect(preBody.quotations.map((q: { id: number }) => q.id)).toContain(seed.devisId);

      // Architect logs in and rotates the link with a NEW email.
      const loginResp = await ctx.request.post("/api/auth/dev-login", {
        data: { email: `${SEED_PREFIX}arch-${uniq}@local.test` },
      });
      expect(loginResp.ok(), `dev-login failed (${loginResp.status()})`).toBe(true);

      const newEmail = `${SEED_PREFIX}newclient-${uniq}@local.test`;
      const issueResp = await ctx.request.post(
        `/api/projects/${seed.projectId}/client-share/issue`,
        { data: { clientEmail: newEmail, clientName: "New Client" } },
      );
      expect(issueResp.ok(), `issue failed (${issueResp.status()})`).toBe(true);
      const issued = await issueResp.json();
      expect(issued.clientEmail).toBe(newEmail);
      // Extract the new raw token from the returned share URL.
      const m = String(issued.shareUrl).match(/\/p\/client\/project\/([A-Za-z0-9_-]+)$/);
      expect(m, `unexpected shareUrl shape: ${issued.shareUrl}`).toBeTruthy();
      const newRawTok = m![1];
      expect(newRawTok).not.toBe(seed.rawTok);

      // 1. OLD token is immediately dead — 404 on the shell and /data.
      const oldShell = await ctx.request.get(`/p/client/project/${seed.rawTok}`);
      expect(oldShell.status(), "old token HTML shell must 404").toBe(404);
      expect(await oldShell.text()).toContain("page-project-share-invalid");

      const oldData = await ctx.request.get(`/p/client/project/${seed.rawTok}/data`);
      expect(oldData.status(), "old token /data must 404").toBe(404);
      const oldDataBody = await oldData.json();
      expect(oldDataBody.expired).toBe(false); // revoked, not expired

      const oldDetail = await ctx.request.get(
        `/p/client/project/${seed.rawTok}/devis/${seed.devisId}/data`,
      );
      expect(oldDetail.status(), "old token detail /data must 404").toBe(404);

      // 2. NEW token works and shows the carried-forward devis.
      const newData = await ctx.request.get(`/p/client/project/${newRawTok}/data`);
      expect(newData.status(), "new token /data must 200").toBe(200);
      const newBody = await newData.json();
      const ids = newBody.quotations.map((q: { id: number }) => q.id);
      expect(ids).toContain(seed.devisId);
      // 3. Exactly once — no duplication in the payload.
      expect(ids.filter((id: number) => id === seed.devisId)).toHaveLength(1);

      // Landing page renders in a real browser with the new client name and the devis card.
      const page = await ctx.newPage();
      const navResp = await page.goto(`/p/client/project/${newRawTok}`);
      expect(navResp?.status()).toBe(200);
      const greeting = page.getByTestId("text-greeting");
      await expect(greeting).toBeVisible({ timeout: 8_000 });
      await expect(greeting).toContainText("New Client");
      await expect(page.getByTestId(`card-quotation-${SEED_PREFIX}D1-${uniq}`)).toBeVisible();

      // DB invariants: old token revoked; membership carried to the new token exactly once.
      const { rows: [oldTok] } = await db.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM client_project_share_tokens WHERE id = $1`,
        [seed.tokenId],
      );
      expect(oldTok.revoked_at, "old token row must be revoked").not.toBeNull();

      const { rows: memberships } = await db.query<{ token_id: number; devis_id: number }>(
        `SELECT m.token_id, m.devis_id
         FROM client_project_share_devis m
         JOIN client_project_share_tokens t ON t.id = m.token_id
         WHERE t.project_id = $1 AND t.revoked_at IS NULL`,
        [seed.projectId],
      );
      expect(memberships).toHaveLength(1);
      expect(memberships[0].devis_id).toBe(seed.devisId);
      expect(memberships[0].token_id).not.toBe(seed.tokenId);
    } finally {
      try { await cleanup(db, seed); } finally { await db.end(); await ctx.close(); }
    }
  });
});
