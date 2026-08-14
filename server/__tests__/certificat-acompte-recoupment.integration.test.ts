import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { db } from "../db";
import { storage } from "../storage";
import { certificats, projects, contractors, marches, devis } from "@shared/schema";
import { eq } from "drizzle-orm";
import certificatsRouter from "../routes/certificats";

/**
 * Task #462 — real-DB pins for paid-acompte recoupment through the
 * certificat lifecycle:
 *
 *  - POST create while the deposit is only 'pending' → no recoupment.
 *  - The deposit turns 'paid' AFTER the draft exists; sealing re-resolves
 *    authoritatively, repairs the drifted figures, and the sealed row +
 *    issuance snapshot carry the recoupment (no double payment).
 *  - A certificat created after a deposit is 'paid' recovers it at create
 *    time (asap rule), and the client cannot inject recoupment fields.
 */

// The seal renders a PDF and mirrors to Drive — irrelevant to the money
// math under test, so both are mocked; everything else hits the real DB.
vi.mock("../communications/certificat-generator", () => ({
  generateCertificatPdf: vi.fn(async (certificatId: number) => ({
    storageKey: `test/seal-${certificatId}.pdf`,
    pdfBuffer: Buffer.from("%PDF"),
    fileName: `CERT-${certificatId}.pdf`,
    sourceInvoiceIds: [],
    driveSeed: null,
  })),
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn().mockResolvedValue(undefined),
}));

import { sealCertificat } from "../services/certificat-seal.service";

let projectId: number;
let contractorId: number;
let devisId: number;
let server: http.Server;
let base: string;

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T462-${Date.now()}`, name: "Acompte recoupment test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db
    .insert(contractors)
    .values({ name: `Acompte Contractor ${Date.now()}` })
    .returning();
  contractorId = c.id;
  // Marché with the default 'asap' recoupment rule, 5% retenue.
  await db.insert(marches).values({
    projectId,
    contractorId,
    totalHt: "10000.00",
    totalTtc: "12000.00",
    retenueGarantiePercent: "5.00",
  });
  // Devis with a 200 € deposit, NOT yet paid.
  const [d] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: "T462.1.recoupment",
      descriptionFr: "Devis avec acompte",
      amountHt: "10000.00",
      amountTtc: "12000.00",
      acompteRequired: true,
      acompteAmountHt: "200.00",
      acompteState: "pending",
    })
    .returning();
  devisId = d.id;

  const app = express();
  app.use(express.json());
  app.use(certificatsRouter);
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
  await db.delete(devis).where(eq(devis.projectId, projectId));
  await db.delete(marches).where(eq(marches.projectId, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

async function createCert(totalWorksHt: string) {
  const res = await fetch(`${base}/api/projects/${projectId}/certificats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contractorId,
      totalWorksHt,
      // Injection attempt — server-derived, must be stripped by Zod.
      cumulativeAcompteRecoupment: "9999.00",
      periodAcompteRecoupment: "9999.00",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, string | number>;
}

describe("paid-acompte recoupment through create + seal", () => {
  it("recovers the deposit exactly once across the lifecycle", async () => {
    // 1. Draft created while the deposit is only 'pending' → no recoupment.
    const draft = await createCert("1000.00");
    expect(draft.cumulativeAcompteRecoupment).toBe("0.00");
    expect(draft.periodAcompteRecoupment).toBe("0.00");
    // retenue 5% of 1000 = 50 → net 950.
    expect(draft.netToPayHt).toBe("950.00");

    // 2. The deposit is paid AFTER the draft exists (facture d'acompte
    //    settled). The stale draft still shows no recoupment...
    await db.update(devis).set({ acompteState: "paid" }).where(eq(devis.id, devisId));

    // 3. ...but sealing re-resolves authoritatively: the sealed row must
    //    carry the recoupment (asap rule → full 200 recovered now).
    const sealed = await sealCertificat(Number(draft.id));
    expect(sealed.alreadySealed).toBe(false);
    const row = await storage.getCertificat(Number(draft.id));
    expect(row!.pdfStorageKey).toBe(`test/seal-${draft.id}.pdf`);
    expect(row!.cumulativeAcompteRecoupment).toBe("200.00");
    expect(row!.periodAcompteRecoupment).toBe("200.00");
    // net = 1000 − 50 retenue − 200 recoupment = 750; TVA 20% → 900 TTC.
    expect(row!.netToPayHt).toBe("750.00");
    expect(row!.tvaAmount).toBe("150.00");
    expect(row!.netToPayTtc).toBe("900.00");
    // The immutable snapshot pins the same figures.
    const snapshot = row!.issuanceSnapshot as Record<string, string>;
    expect(snapshot.cumulativeAcompteRecoupment).toBe("200.00");
    expect(snapshot.netToPayTtc).toBe("900.00");

    // 4. A SECOND certificat sees the prior cumulative recoupment and must
    //    not recover the deposit again (period movement = 0).
    const second = await createCert("2000.00");
    expect(second.cumulativeAcompteRecoupment).toBe("200.00");
    expect(second.periodAcompteRecoupment).toBe("0.00");
    // cumulative retenue 5% of 2000 = 100, prior 50 → period 50.
    // net = period works (1000) − period retenue (50) − period recoupment (0) ... the
    // stored netToPayHt is period-based: 2000 − 1000 prior payments is not
    // modelled here (previousPayments 0), so assert the recoupment fields
    // only — the retenue/net math is pinned by the shared unit suite.
  });

  it("recovers at create time when the deposit is already paid (fresh contractor)", async () => {
    const [c2] = await db.insert(contractors).values({ name: `Acompte C2 ${Date.now()}` }).returning();
    try {
      await db.insert(devis).values({
        projectId,
        contractorId: c2.id,
        devisCode: "T462.2.paid-up-front",
        descriptionFr: "Devis acompte déjà payé",
        amountHt: "5000.00",
        amountTtc: "6000.00",
        acompteRequired: true,
        acompteAmountHt: "300.00",
        acompteState: "paid",
      });
      const res = await fetch(`${base}/api/projects/${projectId}/certificats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractorId: c2.id, totalWorksHt: "1000.00" }),
      });
      expect(res.status).toBe(201);
      const cert = (await res.json()) as Record<string, string>;
      expect(cert.cumulativeAcompteRecoupment).toBe("300.00");
      expect(cert.periodAcompteRecoupment).toBe("300.00");
    } finally {
      await db.delete(certificats).where(eq(certificats.contractorId, c2.id));
      await db.delete(devis).where(eq(devis.contractorId, c2.id));
      await db.delete(contractors).where(eq(contractors.id, c2.id));
    }
  });
});
