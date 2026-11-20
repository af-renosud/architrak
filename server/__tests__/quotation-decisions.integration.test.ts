import { beforeAll, afterAll, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db";
import { projects, contractors, devis, devisTranslations, clientProjectShareTokens, clientProjectShareDevis, clientProjectShareAudit } from "@shared/schema";
import { loadQuotationDecisionSnapshot, loadProjectQuotationDecisionSnapshots, quotationDecisionVersion } from "../services/quotation-decision-snapshot";
import { commitQuotationApprovalStage } from "../services/quotation-stage-commit";
import { publishReviewedQuotation } from "../services/client-project-share";
import { storage } from "../storage";
const suffix = `decision-parity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let projectId: number, contractorId: number, devisId: number, tokenId: number;
beforeAll(async () => {
  const [p] = await db.insert(projects).values({ name: suffix, code: suffix, clientName: "Fixture" }).returning(); projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: suffix }).returning(); contractorId = c.id;
  const [d] = await db.insert(devis).values({ projectId, contractorId, devisCode: suffix, descriptionFr: "Fixture",
    amountHt: "100.00", amountTtc: "120.00", signOffStage: "checked_internal" }).returning(); devisId = d.id;
  await db.insert(devisTranslations).values({ devisId, status: "finalised", headerTranslated: { description: "Fixture", humanReviewed: true }, approvedAt: new Date() });
  const [t] = await db.insert(clientProjectShareTokens).values({ projectId, tokenHash: suffix, clientEmail: "fixture@example.test" }).returning(); tokenId = t.id;
});
afterAll(async () => {
  if (projectId) await db.delete(clientProjectShareAudit).where(eq(clientProjectShareAudit.projectId, projectId));
  if (tokenId) await db.delete(clientProjectShareTokens).where(eq(clientProjectShareTokens.id, tokenId));
  if (devisId) {
    await db.delete(devisTranslations).where(eq(devisTranslations.devisId, devisId));
    await db.delete(devis).where(eq(devis.id, devisId));
  }
  if (contractorId) await db.delete(contractors).where(eq(contractors.id, contractorId));
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
  await pool.end();
});
it("batch and individual snapshots agree; stale stage commits cannot advance", async () => {
  const s = (await loadQuotationDecisionSnapshot(devisId))!;
  expect(quotationDecisionVersion((await loadProjectQuotationDecisionSnapshots(projectId)).get(devisId)!)).toBe(quotationDecisionVersion(s));
  await db.update(devisTranslations).set({ contextsVersion: 1 }).where(eq(devisTranslations.devisId, devisId));
  expect(await commitQuotationApprovalStage(devisId, quotationDecisionVersion(s))).toBeUndefined();
  const fresh = (await loadQuotationDecisionSnapshot(devisId))!;
  expect((await commitQuotationApprovalStage(devisId, quotationDecisionVersion(fresh)))?.signOffStage).toBe("approved_for_signing");
});
it("publication rechecks approval inside the write and writes audit atomically", async () => {
  await db.update(devisTranslations).set({ status: "edited" }).where(eq(devisTranslations.devisId, devisId));
  expect((await publishReviewedQuotation(projectId, tokenId, devisId, null)).ok).toBe(false);
  expect(await db.select().from(clientProjectShareDevis).where(eq(clientProjectShareDevis.tokenId, tokenId))).toHaveLength(0);
  await db.update(devisTranslations).set({ status: "finalised" }).where(eq(devisTranslations.devisId, devisId));
  expect((await publishReviewedQuotation(projectId, tokenId, devisId, null)).ok).toBe(true);
  expect(await db.select().from(clientProjectShareAudit).where(eq(clientProjectShareAudit.projectId, projectId))).toHaveLength(1);
  await db.update(clientProjectShareTokens).set({ revokedAt: new Date() }).where(eq(clientProjectShareTokens.id, tokenId));
  expect((await publishReviewedQuotation(projectId, tokenId, devisId, null)).ok).toBe(false);
});
it("retiring an envelope requires a provider-confirmed draft and preserves its audit", async () => {
  await db.update(devis).set({ archisignEnvelopeId: "obsolete-fixture", archisignEnvelopeStatus: "sent",
    archisignPinnedPdfStorageKey: "old-package", signOffStage: "approved_for_signing" }).where(eq(devis.id, devisId));
  expect(await storage.retireUnsentSignatureEnvelope(devisId, "obsolete-fixture", null as never, "sent")).toBe(false);
  expect(await storage.retireUnsentSignatureEnvelope(devisId, "wrong-envelope", null as never, "draft")).toBe(false);
  expect(await storage.retireUnsentSignatureEnvelope(devisId, "obsolete-fixture", null as never, "draft")).toBe(true);
  const [current] = await db.select().from(devis).where(eq(devis.id, devisId));
  expect(current.archisignEnvelopeId).toBeNull();
  expect(current.archisignPinnedPdfStorageKey).toBeNull();
  const audit = await db.select().from(clientProjectShareAudit).where(eq(clientProjectShareAudit.projectId, projectId));
  expect(audit.some(a => a.action === "signature_envelope_retired" && a.detail?.includes("obsolete-fixture"))).toBe(true);
});
