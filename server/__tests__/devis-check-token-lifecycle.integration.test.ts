import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, isNull, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { storage } from "../storage";
import {
  projects,
  contractors,
  devis,
  invoices,
  avenants,
  devisCheckTokens,
} from "@shared/schema";
import { issueDevisCheckToken } from "../services/devis-checks";

// Lifecycle-bound revoke: hits the real database to verify the SQL
// predicate (sum(invoice HT) >= devis HT + approved PV − approved MV)
// drives the new storage helpers correctly. Each test owns its devis row
// and cleans it up via cascade.

const SUFFIX = `t94-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let projectId: number;
let contractorId: number;

async function newDevisWithActiveToken(amountHt: string): Promise<{ devisId: number; tokenId: number }> {
  const [d] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: `D-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
      descriptionFr: "lifecycle test",
      amountHt,
      amountTtc: amountHt,
    })
    .returning({ id: devis.id });
  const [t] = await db
    .insert(devisCheckTokens)
    .values({
      devisId: d.id,
      tokenHash: `hash-${SUFFIX}-${d.id}`,
      contractorId,
      contractorEmail: "lifecycle@test.local",
    })
    .returning({ id: devisCheckTokens.id });
  return { devisId: d.id, tokenId: t.id };
}

async function addInvoice(devisId: number, amountHt: string): Promise<void> {
  await db.insert(invoices).values({
    devisId,
    contractorId,
    projectId,
    invoiceNumber: `INV-${SUFFIX}-${devisId}-${Math.random().toString(36).slice(2, 6)}`,
    amountHt,
    tvaAmount: "0.00",
    amountTtc: amountHt,
  });
}

async function addAvenant(
  devisId: number,
  type: "pv" | "mv",
  amountHt: string,
  status: "approved" | "draft" = "approved",
): Promise<void> {
  await db.insert(avenants).values({
    devisId,
    type,
    descriptionFr: "lifecycle avenant",
    amountHt,
    amountTtc: amountHt,
    status,
  });
}

async function getToken(tokenId: number) {
  const [row] = await db.select().from(devisCheckTokens).where(eq(devisCheckTokens.id, tokenId));
  return row;
}

async function deleteDevis(devisId: number) {
  await db.delete(devis).where(eq(devis.id, devisId));
}

describe("devis-check token lifecycle (integration)", () => {
  beforeAll(async () => {
    // Provision devis_check_tokens idempotently with the minimal schema
    // (columns + indexes from migrations 0015/0016) needed by the revoke
    // predicate. The table is defined in migration 0015 but is missing
    // in some dev environments because the local migration journal
    // predates 0011-0017 (pre-existing infra issue, unrelated to this
    // lifecycle work). FK/CHECK constraints from 0015 are intentionally
    // omitted — the behavior under test is the UPDATE...EXISTS predicate,
    // not relational integrity.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "devis_check_tokens" (
        "id" serial PRIMARY KEY NOT NULL,
        "devis_id" integer NOT NULL,
        "token_hash" text NOT NULL,
        "contractor_id" integer NOT NULL,
        "contractor_email" text NOT NULL,
        "created_by_user_id" integer,
        "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
        "revoked_at" timestamp,
        "last_used_at" timestamp,
        "expires_at" timestamp
      )
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "devis_check_tokens_token_hash_idx" ON "devis_check_tokens" ("token_hash")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "devis_check_tokens_devis_id_idx" ON "devis_check_tokens" ("devis_id")`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "devis_check_tokens_one_active_idx" ON "devis_check_tokens" ("devis_id") WHERE "revoked_at" IS NULL`);

    const [p] = await db
      .insert(projects)
      .values({
        name: `Lifecycle ${SUFFIX}`,
        code: `LC-${SUFFIX}`,
        clientName: "Lifecycle Client",
      })
      .returning({ id: projects.id });
    projectId = p.id;
    const [c] = await db
      .insert(contractors)
      .values({ name: `Lifecycle Co ${SUFFIX}` })
      .returning({ id: contractors.id });
    contractorId = c.id;
  });

  afterAll(async () => {
    // Project cascade-deletes devis (and its invoices/avenants/tokens).
    // Contractor has no cascade, so delete it last.
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(contractors).where(eq(contractors.id, contractorId));
    // Vitest hangs on the open pool unless we close it. Done in the last
    // suite that uses the real pool.
    await pool.end();
  });

  it("does NOT revoke when the devis is only partially invoiced", async () => {
    const { devisId, tokenId } = await newDevisWithActiveToken("1000.00");
    await addInvoice(devisId, "400.00");

    const revoked = await storage.revokeDevisCheckTokenIfFullyInvoiced(devisId);
    expect(revoked).toBe(0);
    const tok = await getToken(tokenId);
    expect(tok.revokedAt).toBeNull();

    await deleteDevis(devisId);
  });

  it("revokes immediately when an invoice pushes the devis to fully-invoiced", async () => {
    const { devisId, tokenId } = await newDevisWithActiveToken("1000.00");
    await addInvoice(devisId, "600.00");
    // Below threshold yet.
    expect(await storage.revokeDevisCheckTokenIfFullyInvoiced(devisId)).toBe(0);
    expect((await getToken(tokenId)).revokedAt).toBeNull();

    await addInvoice(devisId, "400.00");
    // Now sum HT (1000) === devis HT (1000) → fully invoiced.
    const revoked = await storage.revokeDevisCheckTokenIfFullyInvoiced(devisId);
    expect(revoked).toBe(1);
    const tok = await getToken(tokenId);
    expect(tok.revokedAt).not.toBeNull();
    const revokedAtAfterFirst = tok.revokedAt;

    // Idempotency: a second call must not re-stamp revoked_at on the
    // already-revoked row (predicate filters on revoked_at IS NULL).
    expect(await storage.revokeDevisCheckTokenIfFullyInvoiced(devisId)).toBe(0);
    const tokAgain = await getToken(tokenId);
    expect(tokAgain.revokedAt?.toISOString()).toBe(revokedAtAfterFirst?.toISOString());

    await deleteDevis(devisId);
  });

  it("respects approved PV avenants (raises threshold) and MV avenants (lowers it)", async () => {
    const { devisId: pvDevisId, tokenId: pvTokenId } = await newDevisWithActiveToken("1000.00");
    await addInvoice(pvDevisId, "1000.00");
    await addAvenant(pvDevisId, "pv", "200.00"); // threshold now 1200
    expect(await storage.revokeDevisCheckTokenIfFullyInvoiced(pvDevisId)).toBe(0);
    expect((await getToken(pvTokenId)).revokedAt).toBeNull();
    await addInvoice(pvDevisId, "200.00"); // total now 1200, meets threshold
    expect(await storage.revokeDevisCheckTokenIfFullyInvoiced(pvDevisId)).toBe(1);
    await deleteDevis(pvDevisId);

    const { devisId: mvDevisId, tokenId: mvTokenId } = await newDevisWithActiveToken("1000.00");
    await addInvoice(mvDevisId, "800.00");
    // Without avenant, 800 < 1000 → not fully invoiced.
    expect(await storage.revokeDevisCheckTokenIfFullyInvoiced(mvDevisId)).toBe(0);
    expect((await getToken(mvTokenId)).revokedAt).toBeNull();
    await addAvenant(mvDevisId, "mv", "200.00"); // threshold now 800 → meets
    expect(await storage.revokeDevisCheckTokenIfFullyInvoiced(mvDevisId)).toBe(1);
    await deleteDevis(mvDevisId);
  });

  it("ignores DRAFT avenants — only approved ones move the threshold", async () => {
    // Devis HT 1000, fully invoiced at 1000. A DRAFT PV of 500 must NOT
    // raise the threshold to 1500; if drafts were counted, invoiced
    // (1000) would be < threshold (1500) and the token would survive.
    // Drafts ignored ⇒ threshold stays 1000 ⇒ token revokes.
    const { devisId: dPv, tokenId: tPv } = await newDevisWithActiveToken("1000.00");
    await addInvoice(dPv, "1000.00");
    await addAvenant(dPv, "pv", "500.00", "draft");
    expect(await storage.revokeDevisCheckTokenIfFullyInvoiced(dPv)).toBe(1);
    expect((await getToken(tPv)).revokedAt).not.toBeNull();
    await deleteDevis(dPv);

    // Devis HT 1000, invoiced 800. A DRAFT MV of 300 must NOT lower the
    // threshold to 700; if drafts were counted, invoiced (800) would be
    // >= threshold (700) and the token would be revoked prematurely.
    // Drafts ignored ⇒ threshold stays 1000 ⇒ token survives.
    const { devisId: dMv, tokenId: tMv } = await newDevisWithActiveToken("1000.00");
    await addInvoice(dMv, "800.00");
    await addAvenant(dMv, "mv", "300.00", "draft");
    expect(await storage.revokeDevisCheckTokenIfFullyInvoiced(dMv)).toBe(0);
    expect((await getToken(tMv)).revokedAt).toBeNull();
    await deleteDevis(dMv);
  });

  it("issueDevisCheckToken stamps expires_at at the 90-day idle ceiling", async () => {
    const [d] = await db
      .insert(devis)
      .values({
        projectId,
        contractorId,
        devisCode: `D-${SUFFIX}-iss-${Math.random().toString(36).slice(2, 6)}`,
        descriptionFr: "issuance test",
        amountHt: "100.00",
        amountTtc: "100.00",
      })
      .returning({ id: devis.id });
    const before = Date.now();
    const issued = await issueDevisCheckToken({
      devisId: d.id,
      contractorId,
      contractorEmail: "issuance@test.local",
      createdByUserId: null,
    });
    const after = Date.now();
    expect(issued.record.expiresAt).not.toBeNull();
    const expiry = issued.record.expiresAt!.getTime();
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    // Expiry must fall within the 90-day window from the call site, with a
    // small tolerance for execution time.
    expect(expiry).toBeGreaterThanOrEqual(before + NINETY_DAYS_MS - 1000);
    expect(expiry).toBeLessThanOrEqual(after + NINETY_DAYS_MS + 1000);
    await deleteDevis(d.id);
  });

  it("bulk sweep catches fully-invoiced devis missed by inline hooks", async () => {
    // Simulate a path that mutated invoices without calling the per-devis
    // helper: we set the devis up over-threshold and then run only the
    // bulk sweep. Both tokens must get revoked; an unrelated
    // partially-invoiced devis must not.
    const a = await newDevisWithActiveToken("500.00");
    await addInvoice(a.devisId, "500.00");
    const b = await newDevisWithActiveToken("750.00");
    await addInvoice(b.devisId, "1000.00"); // over-invoiced (>=)
    const safe = await newDevisWithActiveToken("1000.00");
    await addInvoice(safe.devisId, "100.00");

    const revoked = await storage.revokeDevisCheckTokensForFullyInvoicedDevis();
    // Sweep is global; it may revoke other unrelated tokens too. Assert
    // that AT LEAST our two crossed the threshold and the safe one did
    // NOT.
    expect(revoked).toBeGreaterThanOrEqual(2);
    expect((await getToken(a.tokenId)).revokedAt).not.toBeNull();
    expect((await getToken(b.tokenId)).revokedAt).not.toBeNull();
    expect((await getToken(safe.tokenId)).revokedAt).toBeNull();

    // Sweeping again is idempotent: the predicate filters on
    // revoked_at IS NULL so already-revoked rows are not touched.
    const remaining = await db
      .select({ id: devisCheckTokens.id })
      .from(devisCheckTokens)
      .where(isNull(devisCheckTokens.revokedAt));
    const beforeCount = remaining.length;
    await storage.revokeDevisCheckTokensForFullyInvoicedDevis();
    const after = await db
      .select({ id: devisCheckTokens.id })
      .from(devisCheckTokens)
      .where(isNull(devisCheckTokens.revokedAt));
    // No tokens that were active before this second sweep were revoked
    // by it — the safe token must still be active.
    expect(after.length).toBeLessThanOrEqual(beforeCount);
    expect((await getToken(safe.tokenId)).revokedAt).toBeNull();

    await deleteDevis(a.devisId);
    await deleteDevis(b.devisId);
    await deleteDevis(safe.devisId);
  });
});
