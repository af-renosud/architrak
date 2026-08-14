import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import { certificats, certificatPayments, certificatPaymentAudits, projects, contractors } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * Task #465 — real-DB pins for the atomic payment-ledger transactions:
 *
 *  - partial payments accumulate; status only flips at full coverage;
 *  - two CONCURRENT final payments cannot both land after the ledger is
 *    covered (the row lock serializes them; the loser hits the lock);
 *  - superseded / draft certificats refuse payments;
 *  - delete of a missing payment reports not_found, never a fake success;
 *  - audit rows exist for every applied mutation.
 */

let projectId: number;
let contractorId: number;

async function makeCert(status: string, ttc = "1000.00"): Promise<number> {
  const [row] = await db
    .insert(certificats)
    .values({
      projectId,
      contractorId,
      certificateRef: `T465-${status}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      status,
      totalWorksHt: ttc,
      netToPayHt: ttc,
      netToPayTtc: ttc,
      tvaAmount: "0.00",
    })
    .returning();
  return row.id;
}

const entry = (amount: string) => ({ datePaid: "2026-08-14", amount, method: "virement" as const });

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T465-${Date.now()}`, name: "Payments ledger test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `Payments Contractor ${Date.now()}` }).returning();
  contractorId = c.id;
});

afterAll(async () => {
  const certIds = (await db.select({ id: certificats.id }).from(certificats).where(eq(certificats.projectId, projectId))).map((r) => r.id);
  if (certIds.length) {
    await db.delete(certificatPaymentAudits).where(inArray(certificatPaymentAudits.certificatId, certIds));
    await db.delete(certificatPayments).where(inArray(certificatPayments.certificatId, certIds));
    await db.delete(certificats).where(inArray(certificats.id, certIds));
  }
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("atomic payment ledger (real DB)", () => {
  it("accumulates partials, flips at coverage, then locks", async () => {
    const certId = await makeCert("sent");
    const r1 = await storage.createCertificatPaymentAtomic(certId, entry("400.00"));
    expect(r1.outcome).toBe("ok");
    if (r1.outcome === "ok") expect(r1.state.fullyPaid).toBe(false);
    expect((await storage.getCertificat(certId))!.status).toBe("sent");

    const r2 = await storage.createCertificatPaymentAtomic(certId, entry("600.00"));
    expect(r2.outcome).toBe("ok");
    if (r2.outcome === "ok") expect(r2.state.fullyPaid).toBe(true);
    expect((await storage.getCertificat(certId))!.status).toBe("paid");

    // Ledger locked — create/update/delete all refuse.
    const r3 = await storage.createCertificatPaymentAtomic(certId, entry("1.00"));
    expect(r3.outcome).toBe("locked");
    const payments = await storage.getCertificatPayments(certId);
    const upd = await storage.updateCertificatPaymentAtomic(payments[0].id, { amount: "1.00" }, null);
    expect(upd.outcome).toBe("locked");
    const del = await storage.deleteCertificatPaymentAtomic(payments[0].id, null);
    expect(del.outcome).toBe("locked");

    // Audit trail: exactly the two applied creations.
    const audits = await storage.getCertificatPaymentAudits(certId);
    expect(audits.map((a) => a.action)).toEqual(["created", "created"]);
  });

  it("two concurrent final payments: at most one lands once coverage is reached", async () => {
    const certId = await makeCert("sent");
    const [a, b] = await Promise.all([
      storage.createCertificatPaymentAtomic(certId, entry("1000.00")),
      storage.createCertificatPaymentAtomic(certId, entry("1000.00")),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    // The row lock serializes: the second sees a fully-covered ledger.
    expect(outcomes).toEqual(["locked", "ok"]);
    expect((await storage.getCertificat(certId))!.status).toBe("paid");
    expect(await storage.getCertificatPayments(certId)).toHaveLength(1);
  });

  it("superseded and draft certificats refuse payments; grandfathered paid accepts historical entries", async () => {
    expect((await storage.createCertificatPaymentAtomic(await makeCert("superseded"), entry("10.00"))).outcome).toBe("superseded");
    expect((await storage.createCertificatPaymentAtomic(await makeCert("draft"), entry("10.00"))).outcome).toBe("draft");
    // Grandfathered: status 'paid' with no rows — historical entry allowed.
    const grandfathered = await makeCert("paid");
    const r = await storage.createCertificatPaymentAtomic(grandfathered, entry("250.00"));
    expect(r.outcome).toBe("ok");
    expect((await storage.getCertificat(grandfathered))!.status).toBe("paid"); // never un-flips
  });

  it("update/delete of a missing payment is not_found, never fake success", async () => {
    expect((await storage.updateCertificatPaymentAtomic(999999999, { amount: "1.00" }, null)).outcome).toBe("not_found");
    expect((await storage.deleteCertificatPaymentAtomic(999999999, null)).outcome).toBe("not_found");
  });

  it("correction updates the row, audits the BEFORE snapshot, and can flip to paid", async () => {
    const certId = await makeCert("sent");
    const created = await storage.createCertificatPaymentAtomic(certId, entry("900.00"));
    if (created.outcome !== "ok" || !created.payment) throw new Error("setup failed");
    const upd = await storage.updateCertificatPaymentAtomic(created.payment.id, { amount: "1000.00" }, "alice");
    expect(upd.outcome).toBe("ok");
    if (upd.outcome === "ok") expect(upd.state.fullyPaid).toBe(true);
    expect((await storage.getCertificat(certId))!.status).toBe("paid");
    const audits = await storage.getCertificatPaymentAudits(certId);
    const updated = audits.find((a) => a.action === "updated");
    expect(updated?.changedBy).toBe("alice");
    expect((updated?.snapshot as { amount: string }).amount).toBe("900.00");
  });
});
