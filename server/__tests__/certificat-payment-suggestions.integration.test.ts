import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db";
import { storage } from "../storage";
import {
  certificats,
  certificatPayments,
  certificatPaymentAudits,
  certificatPaymentSuggestions,
  projects,
  contractors,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * Task #466 — real-DB pins for payment suggestions:
 *
 *  - one suggestion per Gmail message id (re-poll replays are no-ops);
 *  - at most ONE open pending suggestion per certificat (duplicate "paid"
 *    replies never stack for the same outstanding balance);
 *  - confirm is atomic: writes a source='email' payment + audit, closes the
 *    suggestion, flips paid at coverage; a second confirm reports
 *    already_reviewed and writes nothing;
 *  - dismiss is one-shot.
 */

let projectId: number;
let contractorId: number;
let seq = 0;

async function makeCert(status = "sent", ttc = "1000.00"): Promise<number> {
  const [row] = await db
    .insert(certificats)
    .values({
      projectId,
      contractorId,
      certificateRef: `T466-${Date.now()}-${seq++}-${Math.floor(Math.random() * 1e6)}`,
      status,
      totalWorksHt: ttc,
      netToPayHt: ttc,
      netToPayTtc: ttc,
      tvaAmount: "0.00",
    })
    .returning();
  return row.id;
}

function suggestionData(certificatId: number, messageId: string) {
  return {
    certificatId,
    projectId,
    communicationId: 999999,
    emailMessageId: messageId,
    emailThreadId: "thread-t466",
    senderEmail: "client@example.com",
    emailDate: new Date("2026-08-13T09:00:00Z"),
    matchedExcerpt: "virement effectué ce jour",
    suggestedAmount: "1000.00",
    suggestedDate: "2026-08-13",
    status: "pending_review" as const,
  };
}

beforeAll(async () => {
  const [p] = await db
    .insert(projects)
    .values({ code: `T466-${Date.now()}`, name: "Payment suggestions test", clientName: "Test Client", status: "active" })
    .returning();
  projectId = p.id;
  const [c] = await db.insert(contractors).values({ name: `Suggestions Contractor ${Date.now()}` }).returning();
  contractorId = c.id;
});

afterAll(async () => {
  const certIds = (await db.select({ id: certificats.id }).from(certificats).where(eq(certificats.projectId, projectId))).map((r) => r.id);
  if (certIds.length) {
    await db.delete(certificatPaymentSuggestions).where(inArray(certificatPaymentSuggestions.certificatId, certIds));
    await db.delete(certificatPaymentAudits).where(inArray(certificatPaymentAudits.certificatId, certIds));
    await db.delete(certificatPayments).where(inArray(certificatPayments.certificatId, certIds));
    await db.delete(certificats).where(inArray(certificats.id, certIds));
  }
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("payment suggestions (real DB)", () => {
  it("is idempotent per Gmail message id", async () => {
    const certId = await makeCert();
    const first = await storage.createCertificatPaymentSuggestion(suggestionData(certId, `msg-idem-${certId}`));
    expect(first).not.toBeNull();
    const replay = await storage.createCertificatPaymentSuggestion(suggestionData(certId, `msg-idem-${certId}`));
    expect(replay).toBeNull();
    expect((await storage.getCertificatPaymentSuggestions(certId)).length).toBe(1);
  });

  it("allows at most one OPEN pending suggestion per certificat", async () => {
    const certId = await makeCert();
    const first = await storage.createCertificatPaymentSuggestion(suggestionData(certId, `msg-a-${certId}`));
    expect(first).not.toBeNull();
    // Second "paid" reply (different message id) must not stack.
    const second = await storage.createCertificatPaymentSuggestion(suggestionData(certId, `msg-b-${certId}`));
    expect(second).toBeNull();
    // After dismissal, a new reply may open a fresh suggestion.
    await storage.dismissCertificatPaymentSuggestion(first!.id, "tester");
    const third = await storage.createCertificatPaymentSuggestion(suggestionData(certId, `msg-c-${certId}`));
    expect(third).not.toBeNull();
  });

  it("confirm atomically writes a source='email' payment, audits, flips paid, and is one-shot", async () => {
    const certId = await makeCert();
    const s = await storage.createCertificatPaymentSuggestion(suggestionData(certId, `msg-confirm-${certId}`));
    const r = await storage.confirmCertificatPaymentSuggestionAtomic(
      s!.id,
      { certificatId: certId, datePaid: "2026-08-13", amount: "1000.00", method: "virement", reference: null, loggedBy: "tester" },
      "tester",
    );
    expect(r.outcome).toBe("ok");
    if (r.outcome === "ok") {
      expect(r.payment.source).toBe("email");
      expect(r.state.fullyPaid).toBe(true);
      expect(r.suggestion.status).toBe("confirmed");
      expect(r.suggestion.paymentId).toBe(r.payment.id);
    }
    expect((await storage.getCertificat(certId))!.status).toBe("paid");
    const audits = await storage.getCertificatPaymentAudits(certId);
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe("created");

    // Second confirm attempt: already reviewed, no extra payment.
    const again = await storage.confirmCertificatPaymentSuggestionAtomic(
      s!.id,
      { certificatId: certId, datePaid: "2026-08-13", amount: "1000.00", method: "virement", reference: null, loggedBy: "tester" },
      "tester",
    );
    expect(again.outcome).toBe("already_reviewed");
    expect((await storage.getCertificatPayments(certId)).length).toBe(1);
  });

  it("confirms an ambiguous suggestion after human review and stamps the audit (Task #570)", async () => {
    const certId = await makeCert();
    const s = await storage.createCertificatPaymentSuggestion({
      ...suggestionData(certId, `msg-ambiguous-${certId}`),
      status: "ambiguous",
      matchedExcerpt: null,
    });
    const r = await storage.confirmCertificatPaymentSuggestionAtomic(
      s!.id,
      { certificatId: certId, datePaid: "2026-08-14", amount: "500.00", method: "cheque", reference: "chèque n°42", loggedBy: "tester" },
      "tester",
    );
    expect(r.outcome).toBe("ok");
    if (r.outcome === "ok") {
      expect(r.suggestion.status).toBe("confirmed");
      expect(r.payment.amount).toBe("500.00");
    }
    const audits = await storage.getCertificatPaymentAudits(certId);
    expect(audits.length).toBe(1);
    expect(audits[0].snapshot).toEqual({ suggestionId: s!.id, ambiguousSuggestionHumanReview: true });

    // A pending_review confirm keeps a null snapshot (no human-review stamp).
    const certId2 = await makeCert();
    const s2 = await storage.createCertificatPaymentSuggestion(suggestionData(certId2, `msg-clear-${certId2}`));
    const r2 = await storage.confirmCertificatPaymentSuggestionAtomic(
      s2!.id,
      { certificatId: certId2, datePaid: "2026-08-13", amount: "1000.00", method: "virement", reference: null, loggedBy: "tester" },
      "tester",
    );
    expect(r2.outcome).toBe("ok");
    const audits2 = await storage.getCertificatPaymentAudits(certId2);
    expect(audits2[0].snapshot).toBeNull();

    // Second confirm of the ambiguous suggestion: already reviewed.
    const again = await storage.confirmCertificatPaymentSuggestionAtomic(
      s!.id,
      { certificatId: certId, datePaid: "2026-08-14", amount: "500.00", method: "cheque", reference: null, loggedBy: "tester" },
      "tester",
    );
    expect(again.outcome).toBe("already_reviewed");
    expect((await storage.getCertificatPayments(certId)).length).toBe(1);
  });

  it("confirm refuses draft and superseded certificats", async () => {
    for (const status of ["draft", "superseded"] as const) {
      const certId = await makeCert(status);
      const s = await db
        .insert(certificatPaymentSuggestions)
        .values(suggestionData(certId, `msg-${status}-${certId}`))
        .returning();
      const r = await storage.confirmCertificatPaymentSuggestionAtomic(
        s[0].id,
        { certificatId: certId, datePaid: "2026-08-13", amount: "1000.00", method: "virement", reference: null, loggedBy: null },
        null,
      );
      expect(r.outcome).toBe(status);
      // Suggestion stays open for later review after eg. a re-issue.
      expect((await storage.getCertificatPaymentSuggestion(s[0].id))!.status).toBe("pending_review");
    }
  });

  it("dismiss is one-shot", async () => {
    const certId = await makeCert();
    const s = await storage.createCertificatPaymentSuggestion(suggestionData(certId, `msg-dismiss-${certId}`));
    const d1 = await storage.dismissCertificatPaymentSuggestion(s!.id, "tester");
    expect(d1?.status).toBe("dismissed");
    expect(d1?.reviewedBy).toBe("tester");
    const d2 = await storage.dismissCertificatPaymentSuggestion(s!.id, "tester");
    expect(d2).toBeNull();
  });
});
