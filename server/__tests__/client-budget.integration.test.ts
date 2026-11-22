import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
let sourcePdf: Buffer;
vi.mock("../storage/object-storage", async original => ({
  ...await original<typeof import("../storage/object-storage")>(),
  getDocumentBuffer: vi.fn(async () => sourcePdf),
}));
import { eq } from "drizzle-orm";
import { db, pool } from "../db";
import { clientProjectBudgets, clientProjectShareAudit, contractors, devis, projects, users } from "@shared/schema";
import { getClientBudget, getPublicClientBudget, saveClientBudget } from "../services/client-budget";
const suffix = `budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let projectId: number, contractorId: number, devisId: number, userId: number;
beforeAll(async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); sourcePdf = Buffer.from(await pdf.save());
  [projectId] = (await db.insert(projects).values({ name: suffix, code: suffix, clientName: "Fixture" }).returning()).map(p => p.id);
  [contractorId] = (await db.insert(contractors).values({ name: suffix }).returning()).map(c => c.id);
  [userId] = (await db.insert(users).values({ email: `${suffix}@example.test`, googleId: suffix, gmailPollingEnabled: false }).returning()).map(u => u.id);
  [devisId] = (await db.insert(devis).values({ projectId, contractorId, devisCode: suffix,
    descriptionFr: "Fixture", descriptionUk: "Test roof", amountHt: "100.00", amountTtc: "120.00" }).returning()).map(d => d.id);
});
it("records a source-linked indicative total without changing draft finances or granting approval", async () => {
  await db.update(devis).set({ status: "draft", accountingState: "provisional", pdfStorageKey: "fixture.pdf",
    amountHt: "0", amountTtc: "0", aiExtractedData: {}, manualIntakeReviewRequired: true }).where(eq(devis.id, devisId));
  const state = await getClientBudget(projectId);
  expect(state.candidates[0].canReviewIndicative).toBe(true);
  expect(state.candidates[0].excluded).toBe(false);
  const entry = { devisId, title: "Source reviewed roof budget", refresh: true,
    reviewedTotals: { amountHt: "1000", amountTtc: "1100", pdfPage: 1, confirmedFromPdf: true as const } };
  await expect(saveClientBudget(projectId, userId, { version: state.version, alternativesReviewed: true,
    entries: [{ ...entry, reviewedTotals: { ...entry.reviewedTotals, pdfPage: 2 } }] })).rejects.toThrow("page");
  await saveClientBudget(projectId, userId, { version: state.version, alternativesReviewed: true, entries: [entry] });
  const publicState = await getPublicClientBudget(projectId);
  expect(publicState.unsignedTtc).toBe(1100);
  expect(publicState.entries[0]).not.toHaveProperty("sourceReview");
  const [unchanged] = await db.select().from(devis).where(eq(devis.id, devisId));
  expect(unchanged.amountTtc).toBe("0.00");
  expect(unchanged.accountingState).toBe("provisional");
  const [stored] = await db.select().from(clientProjectBudgets).where(eq(clientProjectBudgets.projectId, projectId));
  expect(stored.entries[0].sourceReview?.digest).toMatch(/^[a-f0-9]{64}$/);
  // Leave the fixture in its original state for the independent concurrency test.
  await db.delete(clientProjectBudgets).where(eq(clientProjectBudgets.projectId, projectId));
  await db.delete(clientProjectShareAudit).where(eq(clientProjectShareAudit.projectId, projectId));
  await db.update(devis).set({ status: "draft", accountingState: "active", pdfStorageKey: null,
    amountHt: "100.00", amountTtc: "120.00", aiExtractedData: null, manualIntakeReviewRequired: false }).where(eq(devis.id, devisId));
});
afterAll(async () => {
  if (projectId) {
    await db.delete(clientProjectShareAudit).where(eq(clientProjectShareAudit.projectId, projectId));
    await db.delete(clientProjectBudgets).where(eq(clientProjectBudgets.projectId, projectId));
  }
  if (devisId) await db.delete(devis).where(eq(devis.id, devisId));
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
  if (contractorId) await db.delete(contractors).where(eq(contractors.id, contractorId));
  if (userId) await db.delete(users).where(eq(users.id, userId));
  await pool.end();
});
it("persists only reviewed snapshots, serialises concurrent saves and audits atomically", async () => {
  const initial = await getClientBudget(projectId);
  const payload = { version: initial.version, entries: [{ devisId, title: "Reviewed roof", refresh: true }], alternativesReviewed: true as const };
  const results = await Promise.allSettled([
    saveClientBudget(projectId, userId, payload),
    saveClientBudget(projectId, userId, payload),
  ]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect((await getPublicClientBudget(projectId)).unsignedTtc).toBe(120);
  const audits = await db.select().from(clientProjectShareAudit).where(eq(clientProjectShareAudit.projectId, projectId));
  expect(audits).toHaveLength(1);
  expect(JSON.parse(audits[0].detail).after[0].title).toBe("Reviewed roof");
  const beforeEdit = await getClientBudget(projectId);
  await db.update(devis).set({ amountHt: "200.00", amountTtc: "240.00" }).where(eq(devis.id, devisId));
  expect((await getPublicClientBudget(projectId)).unsignedTtc).toBe(120);
  await expect(saveClientBudget(projectId, userId, { ...payload, version: beforeEdit.version })).rejects.toThrow("changed");
  const latest = await getClientBudget(projectId);
  await saveClientBudget(projectId, userId, { ...payload, version: latest.version });
  expect((await getPublicClientBudget(projectId)).unsignedTtc).toBe(240);
  const saved = await getClientBudget(projectId);
  await expect(saveClientBudget(projectId, -999999, { ...payload, version: saved.version, entries: [] })).rejects.toThrow();
  // A failed audit foreign key rolls back the visibility change as well.
  expect((await getPublicClientBudget(projectId)).entries).toHaveLength(1);
  await saveClientBudget(projectId, userId, { ...payload, version: saved.version, entries: [] });
  expect((await getPublicClientBudget(projectId)).entries).toEqual([]);
});
