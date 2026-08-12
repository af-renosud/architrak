import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { db } from "../db";
import { storage } from "../storage";
import { certificats, projects, contractors } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import certificatsRouter from "../routes/certificats";

/**
 * Task #457 — real-DB pins for the one-click reissue of a sealed certificat.
 *
 *  - POST /api/certificats/:id/reissue clones a SEALED certificat into a new
 *    draft (next ref, deductions recomputed) and marks the original
 *    `superseded` — atomically (storage.reissueCertificat runs both writes in
 *    ONE transaction).
 *  - Drafts cannot be reissued (409 CERTIFICAT_NOT_SEALED).
 *  - A certificat can be reissued at most once: the partial unique index on
 *    reissued_from_certificat_id elects a single winner under concurrency;
 *    the loser gets 409 CERTIFICAT_ALREADY_REISSUED.
 *  - If the paired supersede write fails, the draft INSERT rolls back too —
 *    the chain can never hold a committed replacement beside a still-active
 *    original.
 */

let projectId: number;
let contractorId: number;
let server: http.Server;
let base: string;

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T457-${Date.now()}`, name: "Reissue test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db
    .insert(contractors)
    .values({ name: `Reissue Contractor ${Date.now()}` })
    .returning();
  contractorId = c.id;

  const app = express();
  app.use(express.json());
  app.use(certificatsRouter);
  // Mirror the app-level error handler: Zod validation errors → 400.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") {
      return res.status(400).json({ message: "Validation failed" });
    }
    res.status(500).json({ message: err instanceof Error ? err.message : "error" });
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.delete(certificats).where(eq(certificats.projectId, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

async function makeSealedCert(ref: string) {
  const [cert] = await db
    .insert(certificats)
    .values({
      projectId,
      contractorId,
      certificateRef: ref,
      totalWorksHt: "1000.00",
      netToPayHt: "950.00",
      tvaAmount: "190.00",
      netToPayTtc: "1140.00",
      status: "sent",
      pdfStorageKey: `test/${ref}.pdf`,
      pdfFileName: `${ref}.pdf`,
      issuedAt: new Date(),
    })
    .returning();
  return cert;
}

describe("POST /api/certificats/:id/reissue", () => {
  it("refuses to reissue a draft (409 CERTIFICAT_NOT_SEALED)", async () => {
    const [draft] = await db
      .insert(certificats)
      .values({
        projectId,
        contractorId,
        certificateRef: `C900`,
        totalWorksHt: "100.00",
        netToPayHt: "95.00",
        tvaAmount: "19.00",
        netToPayTtc: "114.00",
      })
      .returning();
    const res = await fetch(`${base}/api/certificats/${draft.id}/reissue`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("CERTIFICAT_NOT_SEALED");
  });

  it("reissues a sealed certificat: new draft with cloned financials + lineage, original superseded but still sealed", async () => {
    const sealed = await makeSealedCert("C1");
    const res = await fetch(`${base}/api/certificats/${sealed.id}/reissue`, { method: "POST" });
    expect(res.status).toBe(201);
    const draft = (await res.json()) as Record<string, unknown>;

    expect(draft.status).toBe("draft");
    expect(draft.reissuedFromCertificatId).toBe(sealed.id);
    expect(draft.totalWorksHt).toBe("1000.00");
    expect(draft.pdfStorageKey).toBeNull();
    expect(draft.certificateRef).not.toBe(sealed.certificateRef);

    const original = await storage.getCertificat(sealed.id);
    expect(original!.status).toBe("superseded");
    // The pinned PDF stays — the superseded original remains downloadable.
    expect(original!.pdfStorageKey).toBe(sealed.pdfStorageKey);
  });

  it("concurrent reissues elect exactly one winner; the loser gets 409 CERTIFICAT_ALREADY_REISSUED", async () => {
    const sealed = await makeSealedCert("C10");
    const [a, b] = await Promise.all([
      fetch(`${base}/api/certificats/${sealed.id}/reissue`, { method: "POST" }),
      fetch(`${base}/api/certificats/${sealed.id}/reissue`, { method: "POST" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(((await loser.json()) as { code: string }).code).toBe("CERTIFICAT_ALREADY_REISSUED");

    // Exactly one child row exists.
    const children = await storage.getCertificatReissues([sealed.id]);
    expect(children).toHaveLength(1);

    // A later retry also refuses.
    const again = await fetch(`${base}/api/certificats/${sealed.id}/reissue`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  it("superseded is terminal: PATCH cannot reactivate the original (409, status persists)", async () => {
    const sealed = await makeSealedCert("C30");
    const reissue = await fetch(`${base}/api/certificats/${sealed.id}/reissue`, { method: "POST" });
    expect(reissue.status).toBe(201);

    const res = await fetch(`${base}/api/certificats/${sealed.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "sent" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("CERTIFICAT_SUPERSEDED");
    const original = await storage.getCertificat(sealed.id);
    expect(original!.status).toBe("superseded");
  });

  it("PATCH cannot set status to superseded directly (400 — reissue flow only)", async () => {
    const sealed = await makeSealedCert("C40");
    const res = await fetch(`${base}/api/certificats/${sealed.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "superseded" }),
    });
    expect(res.status).toBe(400);
    const cert = await storage.getCertificat(sealed.id);
    expect(cert!.status).toBe("sent");
  });

  it("create endpoint rejects superseded as a client-set status (400)", async () => {
    const res = await fetch(`${base}/api/projects/${projectId}/certificats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractorId, totalWorksHt: "100.00", status: "superseded" }),
    });
    expect(res.status).toBe(400);
  });

  it("send endpoint refuses a superseded certificat (409)", async () => {
    const sealed = await makeSealedCert("C50");
    const reissue = await fetch(`${base}/api/certificats/${sealed.id}/reissue`, { method: "POST" });
    expect(reissue.status).toBe(201);
    const res = await fetch(`${base}/api/projects/${projectId}/certificats/${sealed.id}/send`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("CERTIFICAT_SUPERSEDED");
  });

  it("editing the reissue draft excludes the superseded original from prior cumulatives", async () => {
    const sealed = await makeSealedCert("C60");
    // Give the superseded original a big cumulative retenue: if the resolver
    // ever counted it as prior state, the reissue's recompute would inherit it.
    await db.update(certificats).set({ retenueGarantie: "500.00", cumulativeProrataDeduction: "300.00" }).where(eq(certificats.id, sealed.id));
    const reissue = await fetch(`${base}/api/certificats/${sealed.id}/reissue`, { method: "POST" });
    expect(reissue.status).toBe(201);
    const draft = (await reissue.json()) as { id: number; retenueGarantie: string };
    // No marché → default 5% retenue on 1000.00 gross, no prior floor.
    expect(parseFloat(draft.retenueGarantie)).toBeCloseTo(50, 2);

    // PATCH a financial field on the draft → recompute must STILL exclude
    // the superseded original (no 500.00 floor creeping back in).
    const patched = await fetch(`${base}/api/certificats/${draft.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totalWorksHt: "2000.00" }),
    });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as { retenueGarantie: string; cumulativeProrataDeduction: string };
    expect(parseFloat(after.retenueGarantie)).toBeCloseTo(100, 2);
    expect(parseFloat(after.cumulativeProrataDeduction)).toBeCloseTo(0, 2);
  });

  it("rolls back the draft INSERT when the paired supersede write fails (atomicity)", async () => {
    const sealed = await makeSealedCert("C20");
    // Force the second write inside the transaction to fail: point the
    // supersede UPDATE at a non-existent row while the INSERT itself is
    // valid. The transaction must roll back BOTH writes.
    await expect(
      storage.reissueCertificat(999999999, {
        projectId,
        contractorId,
        certificateRef: "C21",
        dateIssued: null,
        totalWorksHt: "1000.00",
        pvMvAdjustment: "0.00",
        previousPayments: "0.00",
        retenueGarantie: "50.00",
        cumulativeProrataDeduction: "0.00",
        periodProrataDeduction: "0.00",
        netToPayHt: "950.00",
        tvaAmount: "190.00",
        netToPayTtc: "1140.00",
        status: "draft",
        notes: null,
        reissuedFromCertificatId: sealed.id,
      }),
    ).rejects.toThrow(/disappeared during reissue/);

    // No orphan draft was committed; the original is untouched.
    const rows = await db
      .select()
      .from(certificats)
      .where(inArray(certificats.certificateRef, ["C21"]));
    expect(rows.filter((r) => r.projectId === projectId)).toHaveLength(0);
    const original = await storage.getCertificat(sealed.id);
    expect(original!.status).toBe("sent");
    expect((await storage.getCertificatReissues([sealed.id]))).toHaveLength(0);
  });
});
