import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { eq, inArray } from "drizzle-orm";

// The route is auth-gated; the guard semantics under test live below it.
vi.mock("../auth/middleware", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import { db } from "../db";
import {
  projects,
  contractors,
  devis,
  devisLineItems,
  devisLineContexts,
  devisLineContextAssets,
  devisTranslations,
  situations,
  situationLines,
} from "@shared/schema";
import type { DevisTranslationLine } from "@shared/schema";
import { repairLineFragment } from "../services/line-fragment-repair.service";

// Task #356 — the guarded fragment-line repair against the REAL database.
// Reproduces the prod DVP0000661 shape: a continuation paragraph stored as a
// phantom 0.00 € line 3, shifting later line numbers, with hand-edited
// translation entries that must survive the realignment.

const SUFFIX = `t356-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let projectId: number;
let contractorId: number;
const createdDevisIds: number[] = [];

async function seedDevis(opts?: {
  status?: string;
  signOffStage?: string;
  withTranslation?: boolean;
  translationStatus?: string;
  aiLineItems?: Array<Record<string, unknown>>;
}): Promise<{ devisId: number; lineIds: number[] }> {
  const [d] = await db.insert(devis).values({
    projectId,
    contractorId,
    devisCode: `LOT-${SUFFIX}-${createdDevisIds.length}`,
    devisNumber: `DV-${SUFFIX}-${createdDevisIds.length}`,
    descriptionFr: "Test devis",
    amountHt: "4494.48",
    amountTtc: "5393.38",
    status: opts?.status ?? "pending",
    ...(opts?.signOffStage ? { signOffStage: opts.signOffStage } : {}),
    aiExtractedData: opts?.aiLineItems ? { lineItems: opts.aiLineItems } : null,
  }).returning();
  createdDevisIds.push(d.id);

  const rows = [
    { lineNumber: 1, description: "Dm.03 dépose du réseau hydraulique.", totalHt: "980.88" },
    { lineNumber: 2, description: "Ps.11-ps.22 préparation complète du bassin, comprenant", totalHt: "3513.60" },
    { lineNumber: 3, description: "Inspection, relevé de cotes, nettoyage et purge des zones non adhérentes.", totalHt: "0.00" },
    { lineNumber: 4, description: "Ps.25 pose de deux skimmers", totalHt: "3113.88" },
  ];
  const lineIds: number[] = [];
  for (const row of rows) {
    const [li] = await db.insert(devisLineItems).values({ devisId: d.id, ...row }).returning();
    lineIds.push(li.id);
  }

  if (opts?.withTranslation) {
    const lineTranslations: DevisTranslationLine[] = [
      { lineNumber: 1, originalDescription: rows[0].description, translation: "Dm.03 removal of hydraulic network.", edited: false },
      { lineNumber: 2, originalDescription: rows[1].description, translation: "pool preparation asasin", edited: true },
      { lineNumber: 3, originalDescription: rows[2].description, translation: "", edited: true },
      { lineNumber: 4, originalDescription: rows[3].description, translation: "installation of two skimmers", edited: false },
    ];
    await db.insert(devisTranslations).values({
      devisId: d.id,
      status: opts.translationStatus ?? "edited",
      lineTranslations,
      // Simulate already-rendered cached PDFs — a successful repair MUST
      // clear these or users keep downloading the pre-repair document.
      translatedPdfStorageKey: `cache/${SUFFIX}-translated.pdf`,
      combinedPdfStorageKey: `cache/${SUFFIX}-combined.pdf`,
    });
  }

  return { devisId: d.id, lineIds };
}

beforeAll(async () => {
  const [p] = await db.insert(projects).values({ name: `Project ${SUFFIX}`, code: `P-${SUFFIX}`, clientName: `Client ${SUFFIX}` }).returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `Contractor ${SUFFIX}` }).returning();
  contractorId = c.id;
});

afterAll(async () => {
  if (createdDevisIds.length > 0) {
    // situation_lines → devis_line_items has no ON DELETE CASCADE; clear the
    // situations (their lines cascade) before the devis cascade fires.
    const sits = await db.select({ id: situations.id }).from(situations)
      .where(inArray(situations.devisId, createdDevisIds));
    if (sits.length > 0) {
      await db.delete(situations).where(inArray(situations.id, sits.map((s) => s.id)));
    }
    await db.delete(devis).where(inArray(devis.id, createdDevisIds));
  }
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
});

describe("repairLineFragment — DVP0000661-shaped repair (real DB)", () => {
  it("merges the fragment, renumbers, mirrors the JSON, and realigns translations preserving edits", async () => {
    const aiLineItems = [
      { description: "Dm.03 dépose du réseau hydraulique.", total: 980.88 },
      { description: "Ps.11-ps.22 préparation complète du bassin, comprenant", total: 3513.6 },
      { description: "Inspection, relevé de cotes, nettoyage et purge des zones non adhérentes." },
      { description: "Ps.25 pose de deux skimmers", total: 3113.88 },
    ];
    const { devisId } = await seedDevis({ withTranslation: true, aiLineItems });

    const result = await repairLineFragment({
      devisId,
      fragmentLineNumber: 3,
      cleanedTranslation: "Ps.11-ps.22 complete pool preparation, including inspection and cleaning.",
    });
    expect(result.success).toBe(true);
    expect(result.remainingLineCount).toBe(3);

    const lines = await db.select().from(devisLineItems)
      .where(eq(devisLineItems.devisId, devisId)).orderBy(devisLineItems.lineNumber);
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
    expect(lines[1].description).toContain("comprenant");
    expect(lines[1].description).toContain("Inspection, relevé de cotes");
    expect(lines[1].totalHt).toBe("3513.60");
    expect(lines[2].description).toBe("Ps.25 pose de deux skimmers");

    const [dRow] = await db.select().from(devis).where(eq(devis.id, devisId));
    const mirrored = (dRow.aiExtractedData as { lineItems: Array<{ description: string; total?: number }> }).lineItems;
    expect(mirrored).toHaveLength(3);
    expect(mirrored[1].description).toContain("Inspection, relevé de cotes");
    expect(mirrored[1].total).toBe(3513.6);

    const [t] = await db.select().from(devisTranslations).where(eq(devisTranslations.devisId, devisId));
    const lts = t.lineTranslations as DevisTranslationLine[];
    expect(lts.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
    expect(lts[1].translation).not.toContain("asasin");
    expect(lts[1].edited).toBe(true);
    expect(lts[2].translation).toBe("installation of two skimmers");
    expect(t.contextsVersion).toBe(1); // stale-publish guard bumped
    expect(t.translatedPdfStorageKey).toBeNull(); // cached PDFs invalidated
    expect(t.combinedPdfStorageKey).toBeNull();
  });

  it("refuses a priced line, a referenced line, and a missing line", async () => {
    const { devisId } = await seedDevis();
    expect((await repairLineFragment({ devisId, fragmentLineNumber: 4 })).status).toBe(422); // priced
    expect((await repairLineFragment({ devisId, fragmentLineNumber: 9 })).status).toBe(404);
    // Line 3 renamed to carry its own reference → refused.
    await db.update(devisLineItems)
      .set({ description: "Ps.30 nettoyage final offert" })
      .where(eq(devisLineItems.devisId, devisId));
    const refused = await repairLineFragment({ devisId, fragmentLineNumber: 3 });
    expect(refused.status).toBe(422);
    expect(refused.message).toContain("item/lot reference");
  });

  it("refuses when the fragment has a context document, a situation reference, or the devis is signed", async () => {
    const a = await seedDevis();
    await db.insert(devisLineContexts).values({
      devisLineItemId: a.lineIds[2],
      devisId: a.devisId,
      document: { type: "doc" },
    });
    expect((await repairLineFragment({ devisId: a.devisId, fragmentLineNumber: 3 })).message).toContain("context document");

    // An asset row WITHOUT a context document (interrupted save) would be
    // cascade-deleted, orphaning its object in storage — must refuse too.
    const a2 = await seedDevis();
    await db.insert(devisLineContextAssets).values({
      devisLineItemId: a2.lineIds[2],
      devisId: a2.devisId,
      storageKey: `assets/${SUFFIX}-orphan.png`,
      mimeType: "image/png",
      sizeBytes: 123,
    });
    expect((await repairLineFragment({ devisId: a2.devisId, fragmentLineNumber: 3 })).message).toContain("context assets");

    const b = await seedDevis();
    const [sit] = await db.insert(situations).values({
      devisId: b.devisId,
      situationNumber: 1,
      cumulativeHt: "0.00",
      netHt: "0.00",
      netToPayHt: "0.00",
      tvaAmount: "0.00",
      netToPayTtc: "0.00",
    }).returning();
    await db.insert(situationLines).values({
      situationId: sit.id,
      devisLineItemId: b.lineIds[2],
      percentComplete: "0.00",
      cumulativeAmount: "0.00",
      previousAmount: "0.00",
      netAmount: "0.00",
    });
    expect((await repairLineFragment({ devisId: b.devisId, fragmentLineNumber: 3 })).message).toContain("situation");

    const c = await seedDevis({ status: "signed" });
    expect((await repairLineFragment({ devisId: c.devisId, fragmentLineNumber: 3 })).message).toContain("immutable");

    // The real signing lifecycle lives in signOffStage — status alone is not
    // the guard. Eligibility is a positive allowlist: only pre-client stages
    // (received, checked_internal) may be repaired; every other stage —
    // anything the client has seen, agreed, rejected, signed, or void — is
    // refused even with status "pending".
    for (const stage of ["client_review_in_progress", "client_agreed", "client_rejected", "approved_for_signing", "sent_to_client", "client_signed_off", "void"]) {
      const dRef = await seedDevis({ signOffStage: stage });
      const refusal = await repairLineFragment({ devisId: dRef.devisId, fragmentLineNumber: 3 });
      expect(refusal.status, `stage ${stage} must refuse`).toBe(422);
      expect(refusal.message).toContain(stage);
    }
    // Pre-client stages stay eligible.
    const f = await seedDevis({ signOffStage: "checked_internal" });
    expect((await repairLineFragment({ devisId: f.devisId, fragmentLineNumber: 3 })).success).toBe(true);
  });

  it("refuses when the translation is finalised, and skips the JSON mirror on ordinal mismatch", async () => {
    const d = await seedDevis({ withTranslation: true, translationStatus: "finalised" });
    expect((await repairLineFragment({ devisId: d.devisId, fragmentLineNumber: 3 })).message).toContain("finalised");

    // Reordered extraction JSON (same length, wrong ordinal content) must be left untouched.
    const misordered = [
      { description: "Ps.25 pose de deux skimmers", total: 3113.88 },
      { description: "Dm.03 dépose du réseau hydraulique.", total: 980.88 },
      { description: "Ps.11-ps.22 préparation complète du bassin, comprenant", total: 3513.6 },
      { description: "Inspection, relevé de cotes, nettoyage et purge des zones non adhérentes." },
    ];
    const e = await seedDevis({ aiLineItems: misordered });
    const result = await repairLineFragment({ devisId: e.devisId, fragmentLineNumber: 3 });
    expect(result.success).toBe(true);
    const [row] = await db.select().from(devis).where(eq(devis.id, e.devisId));
    expect((row.aiExtractedData as { lineItems: unknown[] }).lineItems).toHaveLength(4); // untouched
  });

  it("route refuses an ambiguous devis number (no uniqueness constraint on devis_number)", async () => {
    // Two devis sharing the same supplier reference — the route must 409,
    // never silently pick one and rewrite its lines.
    // Timeout raised to 30 s: dynamic import of the route inside this test
    // body triggers a cold module load that can exceed the default 5 s in CI.
    const a = await seedDevis();
    const b = await seedDevis();
    const dupNumber = `DUP-${SUFFIX}`;
    await db.update(devis).set({ devisNumber: dupNumber })
      .where(inArray(devis.id, [a.devisId, b.devisId]));

    const { default: router } = await import("../routes/admin-extraction-audit");
    const app = express();
    app.use(express.json());
    app.use(router);
    const server: http.Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const post = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}/api/admin/extraction-audit/merge-line-fragment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const dup = await post({ devisNumber: dupNumber, fragmentLineNumber: 3 });
      expect(dup.status).toBe(409);
      expect((await dup.json()).message).toContain("ambiguous");

      const missing = await post({ devisNumber: `NOPE-${SUFFIX}`, fragmentLineNumber: 3 });
      expect(missing.status).toBe(404);

      // Both devis remain untouched: still 4 lines each.
      for (const id of [a.devisId, b.devisId]) {
        const rows = await db.select().from(devisLineItems).where(eq(devisLineItems.devisId, id));
        expect(rows).toHaveLength(4);
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 30_000);
});
