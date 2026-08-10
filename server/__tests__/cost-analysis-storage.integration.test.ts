import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, pool } from "../db";
import { storage } from "../storage";
import { projects, contractors, devis, devisTranslations, devisCostAnalyses } from "@shared/schema";
import { eq } from "drizzle-orm";

/**
 * Task #378 — cost-analysis storage invariants against the real database:
 *   1. Confirm (draft → confirmed) bumps contexts_version and clears both
 *      cached PDF keys in the same transaction.
 *   2. Draft-only saves do NOT touch the PDF cache.
 *   3. Mutations are refused while the translation is finalised.
 *   4. Optimistic concurrency: stale revisions are rejected.
 *   5. Deleting a confirmed analysis also invalidates the cache.
 *   6. Post-send integrity: analysis changes never touch the pinned
 *      Archisign PDF key on the devis row.
 */

const SUFFIX = `t378-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let projectId: number;
let contractorId: number;
let devisId: number;

const DOC = { version: 1, blocks: [] };

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ name: `CA ${SUFFIX}`, code: `CA-${SUFFIX}`, clientName: "c" })
    .returning({ id: projects.id });
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `CA Co ${SUFFIX}` }).returning({ id: contractors.id });
  contractorId = c.id;
  const [d] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: `CA-D-${SUFFIX}`,
      descriptionFr: "cost analysis test",
      amountHt: "100.00",
      amountTtc: "120.00",
      archisignPinnedPdfStorageKey: "pinned/original.pdf",
    })
    .returning({ id: devis.id });
  devisId = d.id;
  await db.insert(devisTranslations).values({
    devisId,
    status: "draft",
    lineTranslations: [],
    headerTranslated: {},
    contextsVersion: 0,
    translatedPdfStorageKey: "cache/translated.pdf",
    combinedPdfStorageKey: "cache/combined.pdf",
  });
});

afterAll(async () => {
  await db.delete(devisCostAnalyses).where(eq(devisCostAnalyses.devisId, devisId));
  await db.delete(devisTranslations).where(eq(devisTranslations.devisId, devisId));
  await db.delete(devis).where(eq(devis.id, devisId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await pool.end();
});

async function translationRow() {
  const t = await storage.getDevisTranslation(devisId);
  if (!t) throw new Error("translation row missing");
  return t;
}

async function resetCache() {
  await db
    .update(devisTranslations)
    .set({ translatedPdfStorageKey: "cache/translated.pdf", combinedPdfStorageKey: "cache/combined.pdf" })
    .where(eq(devisTranslations.devisId, devisId));
}

describe("cost-analysis storage invariants (task #378)", () => {
  it("draft create does not touch the PDF cache", async () => {
    const before = await translationRow();
    const res = await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: "## Summary\ndraft",
      document: DOC,
      warnings: [],
      status: "draft",
      expectedRevision: null,
    });
    expect(res.outcome).toBe("saved");
    const after = await translationRow();
    expect(after.contextsVersion).toBe(before.contextsVersion);
    expect(after.translatedPdfStorageKey).toBe("cache/translated.pdf");
    expect(after.combinedPdfStorageKey).toBe("cache/combined.pdf");
  });

  it("stale revision is rejected", async () => {
    const res = await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: "x",
      document: DOC,
      warnings: [],
      status: "draft",
      expectedRevision: 999,
    });
    expect(res.outcome).toBe("stale");
    // Create with expectedRevision=null against an existing row is stale too.
    const res2 = await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: "x",
      document: DOC,
      warnings: [],
      status: "draft",
      expectedRevision: null,
    });
    expect(res2.outcome).toBe("stale");
  });

  it("confirm bumps contexts_version and clears both cache keys atomically", async () => {
    const before = await translationRow();
    const existing = await storage.getDevisCostAnalysis(devisId);
    const res = await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: existing!.rawText,
      document: DOC,
      warnings: [],
      status: "confirmed",
      expectedRevision: existing!.revision,
    });
    expect(res.outcome).toBe("saved");
    const after = await translationRow();
    expect(after.contextsVersion).toBe(before.contextsVersion + 1);
    expect(after.translatedPdfStorageKey).toBeNull();
    expect(after.combinedPdfStorageKey).toBeNull();
  });

  it("editing a CONFIRMED analysis (demote to draft) also invalidates the cache", async () => {
    await resetCache();
    const before = await translationRow();
    const existing = await storage.getDevisCostAnalysis(devisId);
    expect(existing!.status).toBe("confirmed");
    const res = await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: "## Summary\nedited",
      document: DOC,
      warnings: [],
      status: "draft",
      expectedRevision: existing!.revision,
    });
    expect(res.outcome).toBe("saved");
    const after = await translationRow();
    expect(after.contextsVersion).toBe(before.contextsVersion + 1);
    expect(after.translatedPdfStorageKey).toBeNull();
    expect(after.combinedPdfStorageKey).toBeNull();
  });

  it("analysis mutations never touch the pinned Archisign PDF key", async () => {
    const d = await storage.getDevis(devisId);
    expect(d!.archisignPinnedPdfStorageKey).toBe("pinned/original.pdf");
  });

  it("mutations are refused while the translation is finalised", async () => {
    await db
      .update(devisTranslations)
      .set({ status: "finalised" })
      .where(eq(devisTranslations.devisId, devisId));
    const existing = await storage.getDevisCostAnalysis(devisId);
    const res = await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: "x",
      document: DOC,
      warnings: [],
      status: "draft",
      expectedRevision: existing!.revision,
    });
    expect(res.outcome).toBe("finalised");
    const del = await storage.deleteDevisCostAnalysisIfRevision(devisId, existing!.revision);
    expect(del.outcome).toBe("finalised");
    await db.update(devisTranslations).set({ status: "draft" }).where(eq(devisTranslations.devisId, devisId));
  });

  it("deleting a confirmed analysis invalidates the cache", async () => {
    let existing = await storage.getDevisCostAnalysis(devisId);
    // Re-confirm first.
    await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: existing!.rawText,
      document: DOC,
      warnings: [],
      status: "confirmed",
      expectedRevision: existing!.revision,
    });
    await resetCache();
    const before = await translationRow();
    existing = await storage.getDevisCostAnalysis(devisId);

    expect((await storage.deleteDevisCostAnalysisIfRevision(devisId, 999)).outcome).toBe("stale");

    const res = await storage.deleteDevisCostAnalysisIfRevision(devisId, existing!.revision);
    expect(res.outcome).toBe("deleted");
    const after = await translationRow();
    expect(after.contextsVersion).toBe(before.contextsVersion + 1);
    expect(after.translatedPdfStorageKey).toBeNull();
    expect(after.combinedPdfStorageKey).toBeNull();
    expect(await storage.getDevisCostAnalysis(devisId)).toBeUndefined();
    expect((await storage.deleteDevisCostAnalysisIfRevision(devisId, 1)).outcome).toBe("not_found");
  });
});
