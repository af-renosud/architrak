import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, pool } from "../db";
import { storage } from "../storage";
import {
  projects,
  contractors,
  devis,
  devisLineItems,
  devisCostAnalyses,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  computeQuotationFingerprint,
  isCostAnalysisQuotationChanged,
  getConfirmedCostAnalysisDocument,
} from "../services/devis-cost-analysis";
import { devisTranslations } from "@shared/schema";
import { buildClientPortalPayload } from "../routes/public-client-checks";

/**
 * Task #381 — staleness detection for confirmed cost analyses:
 *   1. The fingerprint is deterministic and changes when line items or
 *      header amounts change (and only then — translation/scope text is
 *      deliberately excluded).
 *   2. A confirmed analysis with a matching fingerprint is NOT stale;
 *      after a line edit it IS.
 *   3. Draft analyses and legacy NULL fingerprints never report stale.
 *   4. The upsert persists the fingerprint on create and preserves it
 *      when omitted (architect text edits).
 */

const SUFFIX = `t381-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const DOC = { version: 1, blocks: [] };

let projectId: number;
let contractorId: number;
let devisId: number;

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ name: `Stale ${SUFFIX}`, code: `ST-${SUFFIX}`, clientName: "c" })
    .returning({ id: projects.id });
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `Stale Co ${SUFFIX}` }).returning({ id: contractors.id });
  contractorId = c.id;
  const [d] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: `ST-D-${SUFFIX}`,
      descriptionFr: "staleness test",
      amountHt: "100.00",
      amountTtc: "120.00",
    })
    .returning({ id: devis.id });
  devisId = d.id;
  await db.insert(devisLineItems).values({
    devisId,
    lineNumber: 1,
    description: "Ligne un",
    totalHt: "100.00",
  });
});

afterAll(async () => {
  await db.delete(devisTranslations).where(eq(devisTranslations.devisId, devisId));
  await db.delete(devisCostAnalyses).where(eq(devisCostAnalyses.devisId, devisId));
  await db.delete(devisLineItems).where(eq(devisLineItems.devisId, devisId));
  await db.delete(devis).where(eq(devis.id, devisId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await pool.end();
});

describe("cost-analysis staleness (task #381)", () => {
  it("fingerprint is deterministic and ignores non-cost fields", async () => {
    const a = await computeQuotationFingerprint(devisId);
    const b = await computeQuotationFingerprint(devisId);
    expect(a).toBe(b);
    // Scope text change does NOT alter the fingerprint.
    await db.update(devis).set({ descriptionFr: "autre texte" }).where(eq(devis.id, devisId));
    expect(await computeQuotationFingerprint(devisId)).toBe(a);
  });

  it("confirmed analysis with matching fingerprint is fresh; a line edit makes it stale", async () => {
    const fp = await computeQuotationFingerprint(devisId);
    const res = await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: "## Summary\nok",
      document: DOC,
      warnings: [],
      status: "confirmed",
      expectedRevision: null,
      quotationFingerprint: fp,
    });
    expect(res.outcome).toBe("saved");
    const row = (await storage.getDevisCostAnalysis(devisId))!;
    expect(row.quotationFingerprint).toBe(fp);
    expect(await isCostAnalysisQuotationChanged(row)).toBe(false);

    // Change a line amount → stale.
    await db
      .update(devisLineItems)
      .set({ totalHt: "150.00" })
      .where(eq(devisLineItems.devisId, devisId));
    expect(await isCostAnalysisQuotationChanged(row)).toBe(true);
  });

  it("upsert without a fingerprint arg preserves the stored one (text edits)", async () => {
    const before = (await storage.getDevisCostAnalysis(devisId))!;
    const res = await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: "## Summary\nedited",
      document: DOC,
      warnings: [],
      status: "draft",
      expectedRevision: before.revision,
    });
    expect(res.outcome).toBe("saved");
    const after = (await storage.getDevisCostAnalysis(devisId))!;
    expect(after.quotationFingerprint).toBe(before.quotationFingerprint);
  });

  it("draft analyses and NULL fingerprints never report stale", async () => {
    const draft = (await storage.getDevisCostAnalysis(devisId))!;
    expect(draft.status).toBe("draft");
    expect(await isCostAnalysisQuotationChanged(draft)).toBe(false);
    // Legacy row: confirmed but no fingerprint → unknown, not stale.
    expect(
      await isCostAnalysisQuotationChanged({ ...draft, status: "confirmed", quotationFingerprint: null }),
    ).toBe(false);
  });

  // Runs LAST: it leaves the analysis confirmed (+ a finalised translation row).
  it("outbound gate (task #389): a stale confirmed analysis is omitted from the PDF document loader AND the portal payload", async () => {
    // Re-confirm with the CURRENT fingerprint → fresh.
    const before = (await storage.getDevisCostAnalysis(devisId))!;
    const fp = await computeQuotationFingerprint(devisId);
    const res = await storage.upsertDevisCostAnalysisIfRevision({
      devisId,
      rawText: "## Summary\nfresh",
      document: DOC,
      warnings: [],
      status: "confirmed",
      expectedRevision: before.revision,
      quotationFingerprint: fp,
    });
    expect(res.outcome).toBe("saved");

    // Portal payloads only surface analysis on a finalised translation.
    await storage.upsertDevisTranslation({
      devisId,
      status: "finalised",
      headerTranslated: {},
      lineTranslations: [],
    });
    const devisRow = (await storage.getDevis(devisId))!;

    // Fresh → present on both outbound surfaces.
    expect(await getConfirmedCostAnalysisDocument(devisId)).not.toBeNull();
    const freshPayload = await buildClientPortalPayload(devisRow);
    expect(freshPayload.analysisHtml).not.toBeNull();

    // Quotation edit → stale → silently omitted from BOTH surfaces
    // (getConfirmedCostAnalysisDocument feeds the translated/combined
    // package PDF; buildClientPortalPayload feeds the portal JSON).
    await db
      .update(devisLineItems)
      .set({ totalHt: "199.99" })
      .where(eq(devisLineItems.devisId, devisId));
    expect(await getConfirmedCostAnalysisDocument(devisId)).toBeNull();
    const stalePayload = await buildClientPortalPayload(devisRow);
    expect(stalePayload.analysisHtml).toBeNull();
  });
});
