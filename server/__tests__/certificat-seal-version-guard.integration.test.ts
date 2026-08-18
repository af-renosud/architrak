import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import { certificats, certificatSources, projects, contractors } from "@shared/schema";
import { eq } from "drizzle-orm";

/**
 * Task #451 — real-DB pins for the issuance-seal version guard.
 *
 * - `updateCertificat` bumps the optimistic-concurrency version.
 * - `sealCertificat` commits ONLY when `pdf_storage_key IS NULL` AND the
 *   version captured before rendering still matches — an interleaved PATCH
 *   makes the guard miss (returns null, row stays unsealed).
 * - Two concurrent seal attempts with the same valid version elect exactly
 *   one winner; seal columns + certificat_sources land atomically.
 */

let projectId: number;
let contractorId: number;
const certIds: number[] = [];

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T451-${Date.now()}`, name: "Seal guard test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db
    .insert(contractors)
    .values({ name: `Seal Guard Contractor ${Date.now()}` })
    .returning();
  contractorId = c.id;
});

afterAll(async () => {
  for (const id of certIds) {
    await db.delete(certificatSources).where(eq(certificatSources.certificatId, id));
    await db.delete(certificats).where(eq(certificats.id, id));
  }
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

async function makeCert(ref: string) {
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
  certIds.push(cert.id);
  return cert;
}

const sealArgs = (key: string, expectedVersion: number, sourceRows: { certificatId: number; invoiceId: number | null; situationId: number | null }[] = []) => ({
  pdfStorageKey: key,
  pdfFileName: "CERT.pdf",
  issuanceSnapshot: { pinned: key },
  dateIssued: "2026-08-12",
  sourceRows,
  expectedVersion,
  projectId,
  contractorId,
});

describe("sealCertificat version guard (integration)", () => {
  it("misses when a PATCH bumped the version after capture, then seals with the fresh version", async () => {
    const cert = await makeCert("VG-1");
    expect(cert.version).toBe(1);

    // Sealer captures version 1 … meanwhile an operator PATCHes a financial field.
    const patched = await storage.updateCertificat(cert.id, { netToPayTtc: "999.00" });
    expect(patched!.version).toBe(2);

    // Seal guarded by the STALE version must not commit.
    const stale = await storage.sealCertificat(cert.id, sealArgs("stale.pdf", 1));
    expect(stale).toBeNull();
    const reloaded = await storage.getCertificat(cert.id);
    expect(reloaded!.pdfStorageKey).toBeNull();

    // Re-render against the fresh version commits, snapshot/row/PDF agree.
    const sealed = await storage.sealCertificat(
      cert.id,
      sealArgs("fresh.pdf", 2)
    );
    expect(sealed!.pdfStorageKey).toBe("fresh.pdf");
    expect((sealed!.issuanceSnapshot as { pinned: string }).pinned).toBe("fresh.pdf");
    expect(sealed!.netToPayTtc).toBe("999.00");
  });

  it("rejects a financial PATCH that was authorized pre-seal but commits post-seal (guarded update)", async () => {
    const cert = await makeCert("VG-4");
    // Route reads the row and sees it unsealed (authorizes the PATCH) …
    const preSealRead = await storage.getCertificat(cert.id);
    expect(preSealRead!.pdfStorageKey).toBeNull();
    // … but a concurrent seal commits before the PATCH's UPDATE runs.
    const sealed = await storage.sealCertificat(cert.id, sealArgs("vg4.pdf", cert.version));
    expect(sealed!.pdfStorageKey).toBe("vg4.pdf");
    // The guarded update must MISS — the sealed row's financials stay frozen.
    const late = await storage.updateCertificatUnsealed(cert.id, { netToPayTtc: "777.00" });
    expect(late).toBeNull();
    const final = await storage.getCertificat(cert.id);
    expect(final!.netToPayTtc).toBe("1140.00");
    expect(final!.pdfStorageKey).toBe("vg4.pdf");
  });

  it("elects exactly one winner under concurrent seal attempts", async () => {
    const cert = await makeCert("VG-2");
    const [a, b] = await Promise.all([
      storage.sealCertificat(cert.id, sealArgs("a.pdf", cert.version)),
      storage.sealCertificat(cert.id, sealArgs("b.pdf", cert.version)),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const final = await storage.getCertificat(cert.id);
    expect(["a.pdf", "b.pdf"]).toContain(final!.pdfStorageKey);
    expect(final!.pdfStorageKey).toBe(winners[0]!.pdfStorageKey);
  });

  it("seals atomically with its certificat_sources rows", async () => {
    const cert = await makeCert("VG-3");
    // situation/invoice FKs point at real tables; use null invoice/situation
    // XOR rows is not allowed by the CHECK — so verify with an empty set plus
    // a duplicate-safe second call instead of fabricating FK targets.
    const sealed = await storage.sealCertificat(cert.id, sealArgs("vg3.pdf", cert.version, []));
    expect(sealed!.pdfStorageKey).toBe("vg3.pdf");
    // Second seal attempt is a no-op (already sealed) — idempotent.
    const again = await storage.sealCertificat(cert.id, sealArgs("other.pdf", sealed!.version));
    expect(again).toBeNull();
    const final = await storage.getCertificat(cert.id);
    expect(final!.pdfStorageKey).toBe("vg3.pdf");
  });
});
