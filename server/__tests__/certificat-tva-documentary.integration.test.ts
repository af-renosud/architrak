import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";
import { db } from "../db";
import { certificats, projects, contractors, marches, devis, invoices } from "@shared/schema";
import { eq } from "drizzle-orm";
import certificatsRouter from "../routes/certificats";
import invoicesRouter from "../routes/invoices";

const generatorControl = vi.hoisted(() => ({
  afterSnapshot: null as null | (() => Promise<void>),
}));

// The seal renders a PDF and mirrors to Drive — irrelevant to the TVA math
// under test, so both are mocked; everything else hits the real DB.
vi.mock("../communications/certificat-generator", () => ({
  generateCertificatPdf: vi.fn(async (certificatId: number) => {
    const { storage } = await import("../storage");
    const cert = await storage.getCertificat(certificatId);
    if (!cert) throw new Error(`Missing test certificat ${certificatId}`);
    const sources = await storage.getCertificatSources(certificatId);
    const exactInvoiceIds = sources
      .map((source) => source.invoiceId)
      .filter((invoiceId): invoiceId is number => invoiceId != null);
    const sourceInvoices =
      exactInvoiceIds.length > 0
        ? await Promise.all(
            exactInvoiceIds.map((invoiceId) => storage.getInvoice(invoiceId)),
          )
        : (
            await Promise.all(
              (
                await storage.getDevisByProjectAndContractor(
                  cert.projectId,
                  cert.contractorId,
                )
              ).map((row) => storage.getInvoicesByDevis(row.id)),
            )
          ).flat();
    const presentInvoices = sourceInvoices.filter(
      (invoice): invoice is NonNullable<typeof invoice> => invoice != null,
    );
    const sourceInvoiceSnapshot = presentInvoices.map((invoice) => ({
      invoiceId: invoice.id,
      projectId: invoice.projectId,
      contractorId: invoice.contractorId,
      amountHt: invoice.amountHt,
      tvaAmount: invoice.tvaAmount,
      amountTtc: invoice.amountTtc,
      status: invoice.status,
      datePaid: invoice.datePaid,
    }));
    const afterSnapshot = generatorControl.afterSnapshot;
    generatorControl.afterSnapshot = null;
    if (afterSnapshot) await afterSnapshot();
    return {
      storageKey: `test/seal-${certificatId}.pdf`,
      pdfBuffer: Buffer.from("%PDF"),
      fileName: `CERT-${certificatId}.pdf`,
      sourceInvoiceIds: presentInvoices.map((invoice) => invoice.id),
      sourceInvoiceSnapshot,
      driveSeed: null,
    };
  }),
}));
vi.mock("../services/drive/upload-queue.service", () => ({
  enqueueDriveUpload: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../auth/middleware", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { sealCertificat } from "../services/certificat-seal.service";
import { storage } from "../storage";
import { generateCertificatPdf } from "../communications/certificat-generator";

/**
 * Task #479 — real-DB pins for the documentary TVA rate through the
 * certificat routes:
 *
 *  - A signed quotation's persisted HT/TTC establishes the automatic
 *    documentary rate for manual preview and final contextual creation.
 *  - Operators can enter either HT or TTC; the server derives the counterpart.
 *  - TVA decisions/totals are rejected at the public create/PATCH boundary.
 *  - Missing evidence/configuration yields a clear remediation refusal.
 */

let projectId: number;
let contractorId: number;
let devisId: number;
let tenPercentInvoiceId: number;
let server: http.Server;
let base: string;

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T479-${Date.now()}`, name: "TVA documentary test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db
    .insert(contractors)
    .values({
      name: `TVA Contractor ${Date.now()}`,
      iban: "FR7630006000011234567890189",
    })
    .returning();
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
      signOffStage: "client_signed_off",
      status: "confirmed",
    })
    .returning();
  devisId = d.id;
  // Mixed-rate invoices: 1000 HT @10% + 1000 HT @20% → 15% effective.
  const insertedInvoices = await db
    .insert(invoices)
    .values([
      {
        devisId,
        contractorId,
        projectId,
        invoiceNumber: "F-479-10",
        amountHt: "1000.00",
        tvaAmount: "100.00",
        amountTtc: "1100.00",
      },
      {
        devisId,
        contractorId,
        projectId,
        invoiceNumber: "F-479-20",
        amountHt: "1000.00",
        tvaAmount: "200.00",
        amountTtc: "1200.00",
      },
    ])
    .returning();
  tenPercentInvoiceId = insertedInvoices[0].id;

  const app = express();
  app.use(express.json());
  app.use(certificatsRouter);
  app.use(invoicesRouter);
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
    body: JSON.stringify({
      contractorId,
      contextDevisId: devisId,
      totalWorksAmount: "1000.00",
      totalWorksAmountBasis: "ht",
      ...body,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, string | number | boolean>;
}

describe("documentary TVA rate through the certificat routes", () => {
  it("previews HT and TTC entry from the signed quotation's effective rate", async () => {
    const before = await db
      .select({ id: certificats.id })
      .from(certificats)
      .where(eq(certificats.projectId, projectId));
    const htPreview = await fetch(
      `${base}/api/projects/${projectId}/certificats/manual-preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractorId,
          contextDevisId: devisId,
          totalWorksAmount: "1000.00",
          totalWorksAmountBasis: "ht",
        }),
      },
    );
    expect(htPreview.status).toBe(200);
    const ht = await htPreview.json();
    expect(ht.works).toMatchObject({
      amountHt: "1000.00",
      amountTtc: "1150.00",
      enteredBasis: "ht",
    });
    expect(ht.tva).toMatchObject({
      ratePercent: "15.00",
      source: "documentary",
      evidenceKind: "signed_quotation",
    });

    const ttcPreview = await fetch(
      `${base}/api/projects/${projectId}/certificats/manual-preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractorId,
          contextDevisId: devisId,
          totalWorksAmount: "1150.00",
          totalWorksAmountBasis: "ttc",
        }),
      },
    );
    expect(ttcPreview.status).toBe(200);
    const ttc = await ttcPreview.json();
    expect(ttc.works).toMatchObject({
      amountHt: "1000.00",
      amountTtc: "1150.00",
      enteredBasis: "ttc",
    });
    const after = await db
      .select({ id: certificats.id })
      .from(certificats)
      .where(eq(certificats.projectId, projectId));
    expect(after).toHaveLength(before.length);
  });

  it("keeps negative PV/MV adjustments valid and identical for HT and TTC entry", async () => {
    for (const entry of [
      { amount: "1000.00", basis: "ht" },
      { amount: "1150.00", basis: "ttc" },
    ] as const) {
      const previewResponse = await fetch(
        `${base}/api/projects/${projectId}/certificats/manual-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contractorId,
            contextDevisId: devisId,
            totalWorksAmount: entry.amount,
            totalWorksAmountBasis: entry.basis,
            pvMvAdjustment: "-100.00",
          }),
        },
      );
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json();
      expect(preview.works).toMatchObject({
        amountHt: "1000.00",
        amountTtc: "1150.00",
      });
      expect(preview.deductions).toMatchObject({
        netToPayHt: "900.00",
        tvaAmount: "135.00",
        netToPayTtc: "1035.00",
      });

      const cert = await createCert({
        totalWorksAmount: entry.amount,
        totalWorksAmountBasis: entry.basis,
        pvMvAdjustment: "-100.00",
      });
      expect(cert.totalWorksHt).toBe(preview.works.amountHt);
      expect(cert.pvMvAdjustment).toBe("-100.00");
      expect(cert.netToPayHt).toBe(preview.deductions.netToPayHt);
      expect(cert.netToPayTtc).toBe(preview.deductions.netToPayTtc);
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
    }
  });

  it("recomputes the final contextual create and persists documentary provenance", async () => {
    const cert = await createCert({
      totalWorksAmount: "1150.00",
      totalWorksAmountBasis: "ttc",
    });
    expect(cert.totalWorksHt).toBe("1000.00");
    expect(cert.tvaRatePercent).toBe("15.00");
    expect(cert.tvaRateSource).toBe("documentary");
    expect(cert.tvaEvidenceKind).toBe("signed_quotation");
    expect(cert.tvaEvidenceDevisId).toBe(devisId);
    expect(cert.tvaAutoliquidation).toBe(false);
    expect(cert.tvaAmount).toBe("150.00");
    expect(cert.netToPayTtc).toBe("1150.00");
    await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
  });

  it("PATCH reloads the persisted quotation evidence instead of preserving a stale rate", async () => {
    const cert = await createCert({});
    expect(cert.tvaEvidenceDevisId).toBe(devisId);
    await db.update(devis).set({ amountTtc: "11000.00" }).where(eq(devis.id, devisId));
    try {
      const patchedResponse = await fetch(`${base}/api/certificats/${cert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalWorksHt: "1200.00" }),
      });
      expect(patchedResponse.status).toBe(200);
      expect(await patchedResponse.json()).toMatchObject({
        tvaRatePercent: "10.00",
        tvaRateSource: "documentary",
        tvaEvidenceKind: "signed_quotation",
        tvaEvidenceDevisId: devisId,
      });
    } finally {
      await db.update(devis).set({ amountTtc: "11500.00" }).where(eq(devis.id, devisId));
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
    }
  });

  it("seal independently reloads the persisted quotation evidence and audits its identity", async () => {
    const cert = await createCert({});
    await db.update(devis).set({ amountTtc: "11000.00" }).where(eq(devis.id, devisId));
    try {
      await sealCertificat(Number(cert.id));
      const sealed = await storage.getCertificat(Number(cert.id));
      expect(sealed).toMatchObject({
        tvaRatePercent: "10.00",
        tvaRateSource: "documentary",
        tvaEvidenceKind: "signed_quotation",
        tvaEvidenceDevisId: devisId,
        tvaAmount: "100.00",
      });
      expect(sealed!.issuanceSnapshot).toMatchObject({
        tvaRatePercent: "10.00",
        tvaEvidenceKind: "signed_quotation",
        tvaEvidenceDevisId: devisId,
      });
    } finally {
      await db.update(devis).set({ amountTtc: "11500.00" }).where(eq(devis.id, devisId));
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
    }
  });

  it("keeps the contextless entry point configuration-only instead of scanning unrelated invoices", async () => {
    const previewResponse = await fetch(
      `${base}/api/projects/${projectId}/certificats/manual-preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractorId,
          totalWorksAmount: "1000.00",
          totalWorksAmountBasis: "ht",
        }),
      },
    );
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({
      tva: {
        ratePercent: "20.00",
        source: "marche",
        evidenceKind: "configuration",
      },
    });

    const response = await fetch(
      `${base}/api/projects/${projectId}/certificats`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractorId,
          totalWorksAmount: "1000.00",
          totalWorksAmountBasis: "ht",
        }),
      },
    );
    expect(response.status).toBe(201);
    const cert = await response.json();
    expect(cert.tvaRatePercent).toBe("20.00");
    expect(cert.tvaRateSource).toBe("marche");
    expect(cert.tvaEvidenceKind).toBe("configuration");
    expect(cert.tvaAmount).toBe("200.00");
    try {
      const patchResponse = await fetch(
        `${base}/api/certificats/${cert.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ totalWorksHt: "1200.00" }),
        },
      );
      expect(patchResponse.status).toBe(200);
      expect(await patchResponse.json()).toMatchObject({
        totalWorksHt: "1200.00",
        tvaRatePercent: "20.00",
        tvaRateSource: "marche",
        tvaEvidenceKind: "configuration",
        tvaAmount: "240.00",
      });
      await sealCertificat(Number(cert.id));
      const sealed = await storage.getCertificat(Number(cert.id));
      expect(sealed).toMatchObject({
        tvaRatePercent: "20.00",
        tvaRateSource: "marche",
        tvaEvidenceKind: "configuration",
        tvaAmount: "240.00",
      });
    } finally {
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
    }
  });

  it("uses locked current quotation evidence instead of trusting a stale preview", async () => {
    const preview = await fetch(
      `${base}/api/projects/${projectId}/certificats/manual-preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractorId,
          contextDevisId: devisId,
          totalWorksAmount: "1150.00",
          totalWorksAmountBasis: "ttc",
        }),
      },
    );
    expect(preview.status).toBe(200);
    expect((await preview.json()).tva.ratePercent).toBe("15.00");

    await db
      .update(devis)
      .set({ amountTtc: "11000.00" })
      .where(eq(devis.id, devisId));
    try {
      const cert = await createCert({
        totalWorksAmount: "1100.00",
        totalWorksAmountBasis: "ttc",
      });
      expect(cert.totalWorksHt).toBe("1000.00");
      expect(cert.tvaRatePercent).toBe("10.00");
      expect(cert.tvaAmount).toBe("100.00");
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
    } finally {
      await db
        .update(devis)
        .set({ amountTtc: "11500.00" })
        .where(eq(devis.id, devisId));
    }
  });

  it("gives autoliquidation precedence over signed-quotation evidence", async () => {
    await db
      .update(marches)
      .set({ tvaAutoliquidation: true })
      .where(eq(marches.contractorId, contractorId));
    try {
      const preview = await fetch(
        `${base}/api/projects/${projectId}/certificats/manual-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contractorId,
            contextDevisId: devisId,
            totalWorksAmount: "1000.00",
            totalWorksAmountBasis: "ht",
          }),
        },
      );
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({
        works: { amountHt: "1000.00", amountTtc: "1000.00" },
        tva: {
          ratePercent: "0.00",
          autoliquidation: true,
          source: "autoliquidation",
        },
      });
    } finally {
      await db
        .update(marches)
        .set({ tvaAutoliquidation: false })
        .where(eq(marches.contractorId, contractorId));
    }
  });

  it("explicitly rejects forged TVA decisions and totals on create and PATCH", async () => {
    const forgedCreate = await fetch(
      `${base}/api/projects/${projectId}/certificats`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractorId,
          contextDevisId: devisId,
          totalWorksAmount: "1000.00",
          totalWorksAmountBasis: "ht",
          tvaRateOverride: "5.50",
          tvaAmount: "1.00",
        }),
      },
    );
    expect(forgedCreate.status).toBe(400);
    expect(await forgedCreate.json()).toMatchObject({
      code: "CERTIFICATE_TVA_SERVER_MANAGED",
      blockedFields: ["tvaRateOverride", "tvaAmount"],
    });

    const cert = await createCert({});
    const forgedPatch = await fetch(`${base}/api/certificats/${cert.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tvaRatePercent: "5.50",
        tvaEvidenceDevisId: devisId,
        netToPayTtc: "1.00",
      }),
    });
    expect(forgedPatch.status).toBe(400);
    expect(await forgedPatch.json()).toMatchObject({
      code: "CERTIFICATE_TVA_SERVER_MANAGED",
      blockedFields: ["tvaRatePercent", "tvaEvidenceDevisId", "netToPayTtc"],
    });
    await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
  });

  it("keeps certificate identity immutable after creation", async () => {
    const cert = await createCert({});
    const [otherContractor] = await db
      .insert(contractors)
      .values({ name: `TVA Other Contractor ${Date.now()}` })
      .returning();
    try {
      const response = await fetch(`${base}/api/certificats/${cert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractorId: otherContractor.id }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "CERTIFICATE_IDENTITY_IMMUTABLE",
      });
      const row = await storage.getCertificat(Number(cert.id));
      expect(row!.contractorId).toBe(contractorId);
    } finally {
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
      await db
        .delete(contractors)
        .where(eq(contractors.id, otherContractor.id));
    }
  });

  it("serializes concurrent financial PATCHes so inputs and derived totals stay coherent", async () => {
    const cert = await createCert({});
    try {
      const patch = (totalWorksHt: string) =>
        fetch(`${base}/api/certificats/${cert.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ totalWorksHt }),
        });
      const responses = await Promise.all([patch("1200.00"), patch("1400.00")]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);

      const row = await storage.getCertificat(Number(cert.id));
      expect(["1200.00", "1400.00"]).toContain(row!.totalWorksHt);
      expect(row!.netToPayHt).toBe(row!.totalWorksHt);
      expect(row!.tvaRatePercent).toBe("15.00");
      expect(Number(row!.tvaAmount)).toBe(
        Number((Number(row!.totalWorksHt) * 0.15).toFixed(2)),
      );
      expect(Number(row!.netToPayTtc)).toBe(
        Number((Number(row!.netToPayHt) + Number(row!.tvaAmount)).toFixed(2)),
      );
    } finally {
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
    }
  });

  it("keeps a historical signed-quotation decision with no persisted link despite unrelated invoices", async () => {
    const [cert] = await db
      .insert(certificats)
      .values({
        projectId,
        contractorId,
        certificateRef: `C-HIST-${Date.now()}`,
        totalWorksHt: "1000.00",
        netToPayHt: "1000.00",
        tvaRatePercent: "15.00",
        tvaRateSource: "documentary",
        tvaEvidenceKind: "signed_quotation",
        tvaEvidenceDevisId: null,
        tvaAmount: "150.00",
        netToPayTtc: "1150.00",
      })
      .returning();
    expect(cert.tvaRateSource).toBe("documentary");
    expect(cert.tvaRatePercent).toBe("15.00");
    const [unrelated] = await db
      .insert(invoices)
      .values({
        devisId,
        contractorId,
        projectId,
        invoiceNumber: `F-479-UNRELATED-${Date.now()}`,
        amountHt: "2000.00",
        tvaAmount: "400.00",
        amountTtc: "2400.00",
      })
      .returning();
    try {
      const sealed = await sealCertificat(Number(cert.id));
      expect(sealed.alreadySealed).toBe(false);
      const row = await storage.getCertificat(Number(cert.id));
      expect(row!.tvaRateSource).toBe("documentary");
      expect(row!.tvaRatePercent).toBe("15.00");
      expect(row!.tvaEvidenceDevisId).toBeNull();
    } finally {
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
      await db.delete(invoices).where(eq(invoices.id, unrelated.id));
    }
  });

  it("carries signed-quotation TVA authority through seal, reissue, PATCH and reseal", async () => {
    const cert = await createCert({});
    expect(cert).toMatchObject({
      tvaRatePercent: "15.00",
      tvaRateSource: "documentary",
      tvaEvidenceKind: "signed_quotation",
    });
    const [unrelated] = await db
      .insert(invoices)
      .values({
        devisId,
        contractorId,
        projectId,
        invoiceNumber: `F-479-REISSUE-PRESENTATION-${Date.now()}`,
        amountHt: "1000.00",
        tvaAmount: "200.00",
        amountTtc: "1200.00",
      })
      .returning();
    let reissueId: number | null = null;
    try {
      await sealCertificat(Number(cert.id));
      const firstSealed = await storage.getCertificat(Number(cert.id));
      expect(firstSealed).toMatchObject({
        tvaRatePercent: "15.00",
        tvaEvidenceKind: "signed_quotation",
        tvaEvidenceDevisId: devisId,
      });
      expect(await storage.getDevis(devisId)).toMatchObject({
        amountHt: "10000.00",
        amountTtc: "11500.00",
      });
      await db
        .update(devis)
        .set({ amountTtc: "11000.00" })
        .where(eq(devis.id, devisId));

      const reissueResponse = await fetch(
        `${base}/api/certificats/${cert.id}/reissue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      expect(reissueResponse.status).toBe(201);
      const reissue = await reissueResponse.json();
      reissueId = Number(reissue.id);
      expect(reissue).toMatchObject({
        tvaRatePercent: "10.00",
        tvaRateSource: "documentary",
        tvaEvidenceKind: "signed_quotation",
        tvaEvidenceDevisId: devisId,
      });

      const patchResponse = await fetch(
        `${base}/api/certificats/${reissue.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ totalWorksHt: "1200.00" }),
        },
      );
      expect(patchResponse.status).toBe(200);
      expect(await patchResponse.json()).toMatchObject({
        tvaRatePercent: "10.00",
        tvaEvidenceKind: "signed_quotation",
        tvaAmount: "120.00",
      });

      await sealCertificat(reissueId);
      const resealed = await storage.getCertificat(reissueId);
      expect(resealed).toMatchObject({
        tvaRatePercent: "10.00",
        tvaRateSource: "documentary",
        tvaEvidenceKind: "signed_quotation",
        tvaEvidenceDevisId: devisId,
        tvaAmount: "120.00",
      });
    } finally {
      await db
        .update(devis)
        .set({ amountTtc: "11500.00" })
        .where(eq(devis.id, devisId));
      if (reissueId != null) {
        await db.delete(certificats).where(eq(certificats.id, reissueId));
      }
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
      await db.delete(invoices).where(eq(invoices.id, unrelated.id));
    }
  });

  it("returns to the exact signed quotation, not unrelated invoices, when autoliquidation is removed before reissue", async () => {
    await db
      .update(marches)
      .set({ tvaAutoliquidation: true })
      .where(eq(marches.contractorId, contractorId));
    const cert = await createCert({});
    expect(cert).toMatchObject({
      tvaRatePercent: "0.00",
      tvaRateSource: "autoliquidation",
      tvaEvidenceKind: "signed_quotation",
    });
    const [unrelated] = await db
      .insert(invoices)
      .values({
        devisId,
        contractorId,
        projectId,
        invoiceNumber: `F-479-AUTO-REISSUE-${Date.now()}`,
        amountHt: "1000.00",
        tvaAmount: "100.00",
        amountTtc: "1100.00",
      })
      .returning();
    let reissueId: number | null = null;
    try {
      await sealCertificat(Number(cert.id));
      await db
        .update(marches)
        .set({ tvaAutoliquidation: false })
        .where(eq(marches.contractorId, contractorId));

      const response = await fetch(
        `${base}/api/certificats/${cert.id}/reissue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      expect(response.status).toBe(201);
      const reissue = await response.json();
      reissueId = Number(reissue.id);
      expect(reissue).toMatchObject({
        tvaRatePercent: "15.00",
        tvaRateSource: "documentary",
        tvaEvidenceKind: "signed_quotation",
        tvaEvidenceDevisId: devisId,
      });
    } finally {
      await db
        .update(marches)
        .set({ tvaAutoliquidation: false })
        .where(eq(marches.contractorId, contractorId));
      if (reissueId != null) {
        await db.delete(certificats).where(eq(certificats.id, reissueId));
      }
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
      await db.delete(invoices).where(eq(invoices.id, unrelated.id));
    }
  });

  it("re-renders instead of pinning a PDF when an invoice changes after the renderer captured it", async () => {
    const cert = await createCert({});
    const [invoice] = await db
      .insert(invoices)
      .values({
        devisId,
        contractorId,
        projectId,
        invoiceNumber: `F-479-RENDER-RACE-${Date.now()}`,
        amountHt: "100.00",
        tvaAmount: "15.00",
        amountTtc: "115.00",
      })
      .returning();
    const beforeCalls = vi.mocked(generateCertificatPdf).mock.calls.length;
    generatorControl.afterSnapshot = async () => {
      await db
        .update(invoices)
        .set({
          amountHt: "200.00",
          tvaAmount: "30.00",
          amountTtc: "230.00",
        })
        .where(eq(invoices.id, invoice.id));
    };
    try {
      const result = await sealCertificat(Number(cert.id));
      expect(result.alreadySealed).toBe(false);
      expect(
        vi.mocked(generateCertificatPdf).mock.calls.length - beforeCalls,
      ).toBe(2);
      const row = await storage.getCertificat(Number(cert.id));
      expect(row!.pdfStorageKey).not.toBeNull();
    } finally {
      generatorControl.afterSnapshot = null;
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
      await db.delete(invoices).where(eq(invoices.id, invoice.id));
    }
  });

  it("sealing and PATCH keep an invoice-backed rate bound to its exact source set", async () => {
    await db
      .update(invoices)
      .set({ status: "approved" })
      .where(eq(invoices.id, tenPercentInvoiceId));
    const response = await fetch(
      `${base}/api/invoices/${tenPercentInvoiceId}/create-certificat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(201);
    const cert = await response.json();
    expect(cert.tvaRatePercent).toBe("10.00");
    try {
      const invoiceMutation = await fetch(
        `${base}/api/invoices/${tenPercentInvoiceId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amountHt: "500.00",
            amountTtc: "550.00",
          }),
        },
      );
      expect(invoiceMutation.status).toBe(409);
      expect(await invoiceMutation.json()).toMatchObject({
        code: "invoice_certificate_source_immutable",
      });

      const patched = await fetch(`${base}/api/certificats/${cert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalWorksHt: "900.00" }),
      });
      expect(patched.status).toBe(200);
      expect((await patched.json()).tvaRatePercent).toBe("10.00");

      const sealed = await sealCertificat(Number(cert.id));
      expect(sealed.alreadySealed).toBe(false);
      const row = await storage.getCertificat(Number(cert.id));
      expect(row!.tvaRatePercent).toBe("10.00");
      expect(row!.tvaRateSource).toBe("documentary");
    } finally {
      await db.delete(certificats).where(eq(certificats.id, Number(cert.id)));
      await db
        .update(invoices)
        .set({ status: "pending" })
        .where(eq(invoices.id, tenPercentInvoiceId));
    }
  });

  it("refuses preview and creation when no trustworthy TVA evidence or configuration exists", async () => {
    const [c2] = await db
      .insert(contractors)
      .values({ name: `TVA no-evidence ${Date.now()}` })
      .returning();
    try {
      for (const path of [
        `/api/projects/${projectId}/certificats/manual-preview`,
        `/api/projects/${projectId}/certificats`,
      ]) {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contractorId: c2.id,
            totalWorksAmount: "1000.00",
            totalWorksAmountBasis: "ht",
          }),
        });
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({
          code: "TVA_EVIDENCE_REQUIRED",
        });
      }
    } finally {
      await db.delete(certificats).where(eq(certificats.contractorId, c2.id));
      await db.delete(contractors).where(eq(contractors.id, c2.id));
    }
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
        body: JSON.stringify({
          contractorId: c2.id,
          totalWorksAmount: "1000.00",
          totalWorksAmountBasis: "ht",
        }),
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

  it("falls back to the contractor configuration when no document or marché rate exists", async () => {
    const [c3] = await db
      .insert(contractors)
      .values({
        name: `TVA C3 ${Date.now()}`,
        defaultTvaRatePercent: "5.50",
      })
      .returning();
    try {
      const res = await fetch(
        `${base}/api/projects/${projectId}/certificats/manual-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contractorId: c3.id,
            totalWorksAmount: "1000.00",
            totalWorksAmountBasis: "ht",
          }),
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        works: { amountHt: "1000.00", amountTtc: "1055.00" },
        tva: { ratePercent: "5.50", source: "contractor" },
      });
    } finally {
      await db.delete(contractors).where(eq(contractors.id, c3.id));
    }
  });
});
