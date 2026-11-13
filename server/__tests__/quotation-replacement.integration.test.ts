import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../db";
import { accountingStateChanges, contractors, devis, devisReplacements, invoices, projects, users, type InsertDevis } from "@shared/schema";
import { getReplacementHistory, getReplacementOptions, replaceQuotation, replaceQuotationSchema, REPLACEMENT_LOCK_NAMESPACE } from "../services/quotation-replacement.service";
import { getProjectFinancialSummary } from "../services/financial-summary.service";

let projectId: number;
let otherProjectId: number;
let actorId: number;
let contractorId: number;
let otherContractorId: number;
const prefix = `replacement-test-${randomUUID()}`;
async function quote(overrides: Partial<InsertDevis> = {}) {
  const [row] = await db.insert(devis).values({
    projectId, contractorId, devisCode: `Q-${randomUUID()}`, devisNumber: randomUUID(),
    descriptionFr: "Replacement fixture", amountHt: "100.00", amountTtc: "120.00",
    accountingState: "active", status: "pending", ...overrides,
  }).returning();
  return row;
}
async function request(sourceId: number, targetId: number) {
  const options = await getReplacementOptions(sourceId);
  return {
    replacementDevisId: targetId, note: "Items removed for cost savings.",
    sourceVersion: options.source.version,
    targetVersion: options.candidates.find(c => c.id === targetId)?.version ?? "unavailable",
    impactVersion: options.impactVersion, differentContractorAcknowledged: false,
  };
}
beforeAll(async () => {
  const [actor] = await db.insert(users).values({ googleId: prefix, email: `${prefix}@example.test`, firstName: "Test", lastName: "Architect" }).returning();
  actorId = actor.id;
  const ps = await db.insert(projects).values([
    { code: prefix, name: prefix, clientName: "Test Client" },
    { code: `${prefix}-other`, name: `${prefix}-other`, clientName: "Other Client" },
  ]).returning();
  [projectId, otherProjectId] = ps.map(p => p.id);
  const cs = await db.insert(contractors).values([{ name: prefix }, { name: `${prefix}-other` }]).returning();
  [contractorId, otherContractorId] = cs.map(c => c.id);
});
afterAll(async () => {
  if (projectId) {
    await db.delete(devisReplacements).where(inArray(devisReplacements.projectId, [projectId, otherProjectId]));
    await db.delete(projects).where(inArray(projects.id, [projectId, otherProjectId]));
  }
  if (contractorId) await db.delete(contractors).where(inArray(contractors.id, [contractorId, otherContractorId]));
  if (actorId) await db.delete(users).where(eq(users.id, actorId));
});
describe("architect-selected quotation replacement", () => {
  it("requires a nonblank context and confirmation tokens", () => {
    expect(replaceQuotationSchema.safeParse({ replacementDevisId: 3, note: " " }).success).toBe(false);
    expect(replaceQuotationSchema.safeParse({ replacementDevisId: 3, note: "Reason" }).success).toBe(false);
  });
  it("links differing references, preserves signed evidence/invoices, and leaves new quotation unsigned", async () => {
    const old = await quote({ signOffStage: "client_signed_off", status: "signed", signedPdfStorageKey: "test/original-signed.pdf", pdfStorageKey: "test/original.pdf" });
    const replacement = await quote({ amountHt: "80.00", amountTtc: "96.00" });
    const [invoice] = await db.insert(invoices).values({
      devisId: old.id, projectId, contractorId, invoiceNumber: randomUUID(),
      amountHt: "10.00", tvaAmount: "2.00", amountTtc: "12.00", status: "pending",
    }).returning();
    const options = await getReplacementOptions(old.id);
    expect(options.impact.invoices).toBe(1);
    await replaceQuotation(old.id, await request(old.id, replacement.id), actorId);
    const [after] = await db.select().from(devis).where(eq(devis.id, old.id));
    expect(after).toMatchObject({ accountingState: "superseded", signOffStage: "client_signed_off", signedPdfStorageKey: old.signedPdfStorageKey, pdfStorageKey: old.pdfStorageKey });
    const [target] = await db.select().from(devis).where(eq(devis.id, replacement.id));
    expect(target).toEqual(replacement);
    const [remainingInvoice] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(remainingInvoice).toEqual(invoice);
    const history = await getReplacementHistory(projectId);
    expect(history.find(h => h.oldDevisId === old.id)).toMatchObject({
      newDevisId: replacement.id, note: "Items removed for cost savings.", actorName: "Test Architect",
    });
    const audit = await db.select().from(accountingStateChanges).where(eq(accountingStateChanges.devisId, old.id));
    expect(audit).toHaveLength(1);
    expect(audit[0].reason).toBe("human_replace");
    const summary = await getProjectFinancialSummary(projectId);
    expect(summary.success).toBe(true);
    if (summary.success) {
      expect(summary.data.totalContractedHt).toBe(0);
      expect(summary.data.totalContractedTtc).toBe(0);
      expect(summary.data.devis.find(d => d.devisId === replacement.id)?.commitmentEligible).toBe(false);
      expect(summary.data.devis.find(d => d.devisId === old.id)?.commitmentEligible).toBe(false);
    }
  });
  it("rejects self, other-project, void, superseded and archived targets", async () => {
    const old = await quote();
    const live = await quote();
    const body = await request(old.id, live.id);
    await expect(replaceQuotation(old.id, { ...body, replacementDevisId: old.id }, actorId)).rejects.toMatchObject({ code: "SELF_REPLACEMENT" });
    const elsewhere = await quote({ projectId: otherProjectId });
    await expect(replaceQuotation(old.id, { ...body, replacementDevisId: elsewhere.id }, actorId)).rejects.toMatchObject({ code: "INVALID_TARGET" });
    for (const fields of [{ status: "void" }, { accountingState: "superseded" }]) {
      const invalid = await quote(fields);
      expect((await getReplacementOptions(old.id)).candidates.some(c => c.id === invalid.id)).toBe(false);
      await expect(replaceQuotation(old.id, { ...body, replacementDevisId: invalid.id }, actorId)).rejects.toMatchObject({ code: "REPLACEMENT_BLOCKED" });
    }
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
    try {
      expect((await getReplacementOptions(old.id)).blockedReason).toContain("Archived");
      await expect(replaceQuotation(old.id, body, actorId)).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    } finally { await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId)); }
  });
  it("requires acknowledgement for a different contractor", async () => {
    const old = await quote();
    const target = await quote({ contractorId: otherContractorId });
    const body = await request(old.id, target.id);
    await expect(replaceQuotation(old.id, body, actorId)).rejects.toMatchObject({ code: "CONTRACTOR_ACK_REQUIRED" });
    await replaceQuotation(old.id, { ...body, differentContractorAcknowledged: true }, actorId);
  });
  it("rejects edited targets and changed financial impact without partial writes", async () => {
    const old = await quote();
    const target = await quote();
    const body = await request(old.id, target.id);
    await db.update(devis).set({ descriptionFr: "Changed after preview" }).where(eq(devis.id, target.id));
    await expect(replaceQuotation(old.id, body, actorId)).rejects.toMatchObject({ code: "STALE_REVIEW" });
    const refreshed = await request(old.id, target.id);
    await db.insert(invoices).values({ devisId: old.id, projectId, contractorId, invoiceNumber: randomUUID(), amountHt: "10", tvaAmount: "2", amountTtc: "12" });
    await expect(replaceQuotation(old.id, refreshed, actorId)).rejects.toMatchObject({ code: "STALE_IMPACT" });
    expect((await db.select().from(devis).where(eq(devis.id, old.id)))[0].accountingState).toBe("active");
    expect((await getReplacementHistory(projectId)).some(h => h.oldDevisId === old.id)).toBe(false);
  });
  it("blocks both recorded in-flight signatures and sends not yet assigned an envelope", async () => {
    const old = await quote({ archisignEnvelopeStatus: "sent", archisignEnvelopeId: "fixture-envelope" });
    const target = await quote();
    expect((await getReplacementOptions(old.id)).blockedReason).toContain("signature request");
    await expect(replaceQuotation(old.id, await request(old.id, target.id), actorId)).rejects.toMatchObject({ code: "REPLACEMENT_BLOCKED" });
    const unsent = await quote();
    const body = await request(unsent.id, target.id);
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1::int,$2::int)", [REPLACEMENT_LOCK_NAMESPACE, unsent.id]);
      await expect(replaceQuotation(unsent.id, body, actorId)).rejects.toMatchObject({ code: "QUOTATION_BUSY" });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::int,$2::int)", [REPLACEMENT_LOCK_NAMESPACE, unsent.id]);
      client.release();
    }
  });
  it("records a chain but prevents cycles and merging two old quotations into one", async () => {
    const a = await quote(), b = await quote(), c = await quote(), unrelated = await quote();
    await replaceQuotation(a.id, await request(a.id, b.id), actorId);
    await replaceQuotation(b.id, await request(b.id, c.id), actorId);
    const history = await getReplacementHistory(projectId);
    expect(history.filter(h => h.oldDevisId === a.id || h.oldDevisId === b.id)).toHaveLength(2);
    await expect(replaceQuotation(c.id, { ...await request(c.id, unrelated.id), replacementDevisId: a.id }, actorId)).rejects.toMatchObject({ code: "REPLACEMENT_BLOCKED" });
    await expect(replaceQuotation(unrelated.id, await request(unrelated.id, c.id), actorId)).rejects.toBeDefined();
  });
  it("allows only one simultaneous replacement of the same source", async () => {
    const old = await quote(), first = await quote(), second = await quote();
    const a = await request(old.id, first.id), b = await request(old.id, second.id);
    const results = await Promise.allSettled([replaceQuotation(old.id, a, actorId), replaceQuotation(old.id, b, actorId)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await getReplacementHistory(projectId)).filter(h => h.oldDevisId === old.id)).toHaveLength(1);
  });
});
