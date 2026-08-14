import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { db } from "../db";
import { certificats, projects, contractors, marches, devis, invoices } from "@shared/schema";
import { eq } from "drizzle-orm";
import certificatsRouter from "../routes/certificats";

// The seal renders a PDF and mirrors to Drive — irrelevant to the TVA math
// under test, so both are mocked; everything else hits the real DB.
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
import { storage } from "../storage";

/**
 * Task #479 — real-DB pins for the documentary TVA rate through the
 * certificat routes:
 *
 *  - Mixed-rate invoices (10% + 20%) → blended effective rate applied,
 *    provenance persisted as 'documentary', and the client cannot inject
 *    tvaRateSource / tvaRatePercent.
 *  - Draft override still wins (provenance 'override').
 *  - No invoices → configured marché rate (provenance 'marche').
 */

let projectId: number;
let contractorId: number;
let devisId: number;
let server: http.Server;
let base: string;

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T479-${Date.now()}`, name: "TVA documentary test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `TVA Contractor ${Date.now()}` }).returning();
  contractorId = c.id;
  // Marché with an explicit 20% rate — the documentary rate must beat it.
  await db.insert(marches).values({
    projectId,
    contractorId,
    totalHt: "10000.00",
    totalTtc: "11500.00",
    retenueGarantiePercent: "0.00",
    tvaRatePercent: "20.00",
  });
  const [d] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: "T479.1.mixed-tva",
      descriptionFr: "Devis rénovation taux mixtes",
      amountHt: "10000.00",
      amountTtc: "11500.00",
    })
    .returning();
  devisId = d.id;
  // Mixed-rate invoices: 1000 HT @10% + 1000 HT @20% → 15% effective.
  await db.insert(invoices).values([
    { devisId, contractorId, projectId, invoiceNumber: "F-479-10", amountHt: "1000.00", tvaAmount: "100.00", amountTtc: "1100.00" },
    { devisId, contractorId, projectId, invoiceNumber: "F-479-20", amountHt: "1000.00", tvaAmount: "200.00", amountTtc: "1200.00" },
  ]);

  const app = express();
  app.use(express.json());
  app.use(certificatsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.delete(certificats).where(eq(certificats.projectId, projectId));
  await db.delete(invoices).where(eq(invoices.projectId, projectId));
  await db.delete(devis).where(eq(devis.projectId, projectId));
  await db.delete(marches).where(eq(marches.projectId, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

async function createCert(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/projects/${projectId}/certificats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contractorId, totalWorksHt: "1000.00", ...body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, string | number | boolean>;
}

describe("documentary TVA rate through the certificat routes", () => {
  it("applies the blended effective rate from mixed-rate invoices and pins provenance", async () => {
    const cert = await createCert({
      // Injection attempts — server-derived, must be stripped by Zod.
      tvaRatePercent: "99.99",
      tvaRateSource: "override",
    });
    // (1100+1200 − 2000) / 2000 = 15% — beats the marché's configured 20%.
    expect(cert.tvaRatePercent).toBe("15.00");
    expect(cert.tvaRateSource).toBe("documentary");
    expect(cert.tvaAutoliquidation).toBe(false);
    // net HT 1000 (no retenue) → TVA 150, TTC 1150.
    expect(cert.tvaAmount).toBe("150.00");
    expect(cert.netToPayTtc).toBe("1150.00");
    await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
  });

  it("a draft override still beats the documentary rate", async () => {
    const cert = await createCert({ tvaRateOverride: "5.50" });
    expect(cert.tvaRatePercent).toBe("5.50");
    expect(cert.tvaRateSource).toBe("override");
    await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
  });

  it("PATCH re-resolves: a financial recompute without the override returns to the documentary rate", async () => {
    const cert = await createCert({ tvaRateOverride: "5.50" });
    const res = await fetch(`${base}/api/certificats/${cert.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totalWorksHt: "1000.00" }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, string>;
    expect(updated.tvaRatePercent).toBe("15.00");
    expect(updated.tvaRateSource).toBe("documentary");
    await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
  });

  it("sealing keeps 'documentary' provenance and refreshes the rate from evidence added since the draft", async () => {
    const cert = await createCert({});
    expect(cert.tvaRateSource).toBe("documentary");
    expect(cert.tvaRatePercent).toBe("15.00");
    // New invoice lands AFTER the draft: 2000 HT @10% → blended rate drops
    // to (3300+2200 − 4000)/4000 = 12.5%. Sealing must re-derive it.
    const [inv] = await db.insert(invoices).values({
      devisId, contractorId, projectId,
      invoiceNumber: "F-479-LATE", amountHt: "2000.00", tvaAmount: "200.00", amountTtc: "2200.00",
    }).returning();
    try {
      const sealed = await sealCertificat(Number(cert.id));
      expect(sealed.alreadySealed).toBe(false);
      const row = await storage.getCertificat(Number(cert.id));
      expect(row!.tvaRateSource).toBe("documentary");
      expect(row!.tvaRatePercent).toBe("12.50");
      expect(row!.tvaAmount).toBe("125.00");
      const snapshot = row!.issuanceSnapshot as Record<string, string>;
      expect(snapshot.tvaRateSource).toBe("documentary");
      expect(snapshot.tvaRatePercent).toBe("12.50");
    } finally {
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
      await db.delete(invoices).where(eq(invoices.id, inv.id));
    }
  });

  it("sealing preserves an architect override (provenance stays 'override')", async () => {
    const cert = await createCert({ tvaRateOverride: "5.50" });
    const sealed = await sealCertificat(Number(cert.id));
    expect(sealed.alreadySealed).toBe(false);
    const row = await storage.getCertificat(Number(cert.id));
    expect(row!.tvaRateSource).toBe("override");
    expect(row!.tvaRatePercent).toBe("5.50");
    await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
  });

  it("falls back to the marché rate with 'marche' provenance when no invoices exist", async () => {
    const [c2] = await db.insert(contractors).values({ name: `TVA C2 ${Date.now()}` }).returning();
    try {
      await db.insert(marches).values({
        projectId,
        contractorId: c2.id,
        totalHt: "5000.00",
        totalTtc: "5500.00",
        retenueGarantiePercent: "0.00",
        tvaRatePercent: "10.00",
      });
      const res = await fetch(`${base}/api/projects/${projectId}/certificats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractorId: c2.id, totalWorksHt: "1000.00" }),
      });
      expect(res.status).toBe(201);
      const cert = (await res.json()) as Record<string, string>;
      expect(cert.tvaRatePercent).toBe("10.00");
      expect(cert.tvaRateSource).toBe("marche");
    } finally {
      await db.delete(certificats).where(eq(certificats.contractorId, c2.id));
      await db.delete(marches).where(eq(marches.contractorId, c2.id));
      await db.delete(contractors).where(eq(contractors.id, c2.id));
    }
  });
});
