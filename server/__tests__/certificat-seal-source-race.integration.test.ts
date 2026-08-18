import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage, CertificatSourceConflictError } from "../storage";
import {
  certificats,
  certificatSources,
  projects,
  contractors,
  marches,
  devis,
  invoices,
} from "@shared/schema";
import { eq, inArray, ne, and } from "drizzle-orm";
import {
  createCertificatFromInvoices,
  DerivationRefusedError,
} from "../services/certificat-from-invoices.service";

/**
 * Task #605 — one facture must never be authorized for payment by TWO live
 * certificats.
 *
 * The grouped/single "from facture" creation path records explicit
 * certificat_sources rows under a per-(project, contractor) advisory lock
 * with a tx-scoped re-check. A MANUAL certificat (created without explicit
 * sources) links every invoice in its rendered annexe at SEAL time; that
 * pass now takes the SAME advisory lock and REFUSES the whole seal
 * (CertificatSourceConflictError, full rollback — no seal columns, no PDF
 * pinned, no snapshot) when any rendered source is already certified by
 * another non-superseded certificat. Silently dropping just the link would
 * still issue a PDF whose figures include the contested facture.
 *
 * Pins:
 * - Sequential: grouped cert exists → the manual seal REFUSES; the
 *   certificat stays unsealed (no pdfStorageKey, no issuanceSnapshot) and
 *   no source rows land.
 * - Superseded certs do not block sealing.
 * - Race: grouped creation vs manual seal for the same facture — whatever
 *   the interleaving, exactly ONE live certificat sources the facture, and
 *   the loser issues NOTHING (grouped refused, or seal rolled back
 *   unsealed).
 */

let projectId: number;
let contractorId: number;
let devisId: number;

async function insertInvoice(num: string, ht: string, ttc: string) {
  const [inv] = await db
    .insert(invoices)
    .values({
      devisId,
      contractorId,
      projectId,
      invoiceNumber: num,
      amountHt: ht,
      tvaAmount: "0.00",
      amountTtc: ttc,
      status: "pending",
    })
    .returning();
  return inv;
}

async function makeManualCert(ref: string) {
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
    })
    .returning();
  return cert;
}

const sealArgs = (
  key: string,
  expectedVersion: number,
  sourceRows: { certificatId: number; invoiceId: number | null; situationId: number | null }[],
) => ({
  pdfStorageKey: key,
  pdfFileName: "CERT.pdf",
  issuanceSnapshot: { pinned: key },
  dateIssued: "2026-08-18",
  sourceRows,
  expectedVersion,
  projectId,
  contractorId,
});

async function liveSourcesForInvoice(invoiceId: number) {
  return db
    .select({ certificatId: certificatSources.certificatId })
    .from(certificatSources)
    .innerJoin(certificats, eq(certificatSources.certificatId, certificats.id))
    .where(and(eq(certificatSources.invoiceId, invoiceId), ne(certificats.status, "superseded")));
}

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T605-${Date.now()}`, name: "Seal source race test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `T605 Contractor ${Date.now()}` }).returning();
  contractorId = c.id;
  await db.insert(marches).values({
    projectId,
    contractorId,
    totalHt: "20000.00",
    totalTtc: "24000.00",
    retenueGarantiePercent: "5.00",
  });
  const [d] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: "T605.A",
      descriptionFr: "Devis T605",
      amountHt: "20000.00",
      amountTtc: "24000.00",
      signOffStage: "client_signed_off",
      status: "confirmed",
    })
    .returning();
  devisId = d.id;
});

afterAll(async () => {
  const certRows = await db.select({ id: certificats.id }).from(certificats).where(eq(certificats.projectId, projectId));
  if (certRows.length) {
    await db.delete(certificatSources).where(inArray(certificatSources.certificatId, certRows.map((r) => r.id)));
  }
  await db.delete(certificats).where(eq(certificats.projectId, projectId));
  await db.delete(invoices).where(eq(invoices.projectId, projectId));
  await db.delete(marches).where(eq(marches.projectId, projectId));
  await db.delete(devis).where(eq(devis.projectId, projectId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("Task #605 — manual seal cannot double-certify a facture (integration)", () => {
  it("REFUSES the seal (full rollback) when an annexe invoice is already certified by a live grouped certificat", async () => {
    const claimed = await insertInvoice("T605-SEQ-1", "1000.00", "1200.00");
    const other = await insertInvoice("T605-SEQ-2", "500.00", "600.00");

    const grouped = await createCertificatFromInvoices([claimed.id], { projectId, contractorId });

    const manual = await makeManualCert("T605-M1");
    await expect(
      storage.sealCertificat(
        manual.id,
        sealArgs("m1.pdf", manual.version, [
          { certificatId: manual.id, invoiceId: claimed.id, situationId: null },
          { certificatId: manual.id, invoiceId: other.id, situationId: null },
        ]),
      ),
    ).rejects.toBeInstanceOf(CertificatSourceConflictError);

    // Full rollback: the manual certificat is NOT sealed — no pinned PDF, no
    // issuance snapshot, so no document authorizing the contested facture
    // ever exists.
    const reloaded = await storage.getCertificat(manual.id);
    expect(reloaded!.pdfStorageKey).toBeNull();
    expect(reloaded!.issuanceSnapshot).toBeNull();

    // The claimed facture keeps exactly one live source: the grouped cert.
    const claimedSources = await liveSourcesForInvoice(claimed.id);
    expect(claimedSources).toHaveLength(1);
    expect(claimedSources[0].certificatId).toBe(grouped.id);
    // Nothing partial landed for the other invoice either.
    expect(await liveSourcesForInvoice(other.id)).toHaveLength(0);
  });

  it("carries the claiming certificat's ref in the operator-facing refusal", async () => {
    const inv = await insertInvoice("T605-REF-1", "400.00", "480.00");
    const grouped = await createCertificatFromInvoices([inv.id], { projectId, contractorId });
    const manual = await makeManualCert("T605-M4");
    try {
      await storage.sealCertificat(
        manual.id,
        sealArgs("m4.pdf", manual.version, [{ certificatId: manual.id, invoiceId: inv.id, situationId: null }]),
      );
      expect.unreachable("seal should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(CertificatSourceConflictError);
      const conflict = err as CertificatSourceConflictError;
      expect(conflict.conflictingInvoiceIds).toEqual([inv.id]);
      expect(conflict.claimingCertificateRefs).toEqual([grouped.certificateRef]);
      expect(conflict.message).toContain(grouped.certificateRef);
      expect(conflict.message).toContain("déjà certifiée");
    }
  });

  it("a superseded certificat's source rows do not block the seal", async () => {
    const inv = await insertInvoice("T605-SUP-1", "800.00", "960.00");
    const old = await createCertificatFromInvoices([inv.id], { projectId, contractorId });
    await db.update(certificats).set({ status: "superseded" }).where(eq(certificats.id, old.id));

    const manual = await makeManualCert("T605-M2");
    const sealed = await storage.sealCertificat(
      manual.id,
      sealArgs("m2.pdf", manual.version, [{ certificatId: manual.id, invoiceId: inv.id, situationId: null }]),
    );
    expect(sealed).not.toBeNull();
    expect(sealed!.pdfStorageKey).toBe("m2.pdf");

    const live = await liveSourcesForInvoice(inv.id);
    expect(live).toHaveLength(1);
    expect(live[0].certificatId).toBe(manual.id);
  });

  it("RACE: grouped creation vs manual seal of the same facture — exactly one live certificat, the loser issues nothing", async () => {
    const inv = await insertInvoice("T605-RACE-1", "1500.00", "1800.00");
    const manual = await makeManualCert("T605-M3");

    const [groupedResult, sealResult] = await Promise.allSettled([
      createCertificatFromInvoices([inv.id], { projectId, contractorId }),
      storage.sealCertificat(
        manual.id,
        sealArgs("m3.pdf", manual.version, [{ certificatId: manual.id, invoiceId: inv.id, situationId: null }]),
      ),
    ]);

    const live = await liveSourcesForInvoice(inv.id);
    expect(live).toHaveLength(1);

    const manualReloaded = await storage.getCertificat(manual.id);

    if (sealResult.status === "fulfilled") {
      // Seal won the lock: it owns the facture, and grouped creation must
      // have been refused by its tx-scoped already-certified re-check.
      expect(sealResult.value).not.toBeNull();
      expect(live[0].certificatId).toBe(manual.id);
      expect(groupedResult.status).toBe("rejected");
      if (groupedResult.status === "rejected") {
        expect(groupedResult.reason).toBeInstanceOf(DerivationRefusedError);
      }
      expect(manualReloaded!.pdfStorageKey).toBe("m3.pdf");
    } else {
      // Grouped creation won: the seal REFUSED and rolled back — the manual
      // certificat stays unsealed, no snapshot, no PDF pinned, its rendered
      // figures never became a payment authorization.
      expect(sealResult.reason).toBeInstanceOf(CertificatSourceConflictError);
      expect(groupedResult.status).toBe("fulfilled");
      if (groupedResult.status === "fulfilled") {
        expect(live[0].certificatId).toBe(groupedResult.value.id);
      }
      expect(manualReloaded!.pdfStorageKey).toBeNull();
      expect(manualReloaded!.issuanceSnapshot).toBeNull();
    }
  });
});
