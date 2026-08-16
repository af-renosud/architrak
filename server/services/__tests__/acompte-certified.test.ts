import { describe, expect, it } from "vitest";
import {
  computeAcompteCertifiedByDevis,
  type AcompteCertificatLike,
  type AcompteDevisLike,
} from "../financial-summary.service";

// Task #546 — outstanding acompte certificats must count in the Certified
// figures, recoupment-aware so progress work never double-counts.

const CONTRACTOR = 7;

function acompteCert(over: Partial<AcompteCertificatLike> = {}): AcompteCertificatLike {
  return {
    id: 1,
    acompteDevisId: 26,
    contractorId: CONTRACTOR,
    status: "ready",
    totalWorksHt: "1240.00",
    tvaRatePercent: "20.00",
    cumulativeAcompteRecoupment: "0.00",
    dateIssued: "2026-08-16",
    ...over,
  };
}

function progressCert(over: Partial<AcompteCertificatLike> = {}): AcompteCertificatLike {
  return {
    id: 2,
    acompteDevisId: null,
    contractorId: CONTRACTOR,
    status: "ready",
    totalWorksHt: "5000.00",
    tvaRatePercent: "20.00",
    cumulativeAcompteRecoupment: "0.00",
    dateIssued: "2026-09-01",
    ...over,
  };
}

const devisList: AcompteDevisLike[] = [{ id: 26, acompteState: "paid" }];

describe("computeAcompteCertifiedByDevis", () => {
  it("acompte-only project: the issued acompte counts in full (prod repro C1)", () => {
    const out = computeAcompteCertifiedByDevis([acompteCert()], devisList);
    expect(out.get(26)).toEqual({ ht: 1240, ttc: 1488 });
  });

  it("draft acompte does not count on dashboards", () => {
    const out = computeAcompteCertifiedByDevis([acompteCert({ status: "draft" })], devisList);
    expect(out.get(26)).toBeUndefined();
  });

  it("draft acompte counts when treated as issued (own PDF at seal time)", () => {
    const out = computeAcompteCertifiedByDevis([acompteCert({ status: "draft" })], devisList, [1]);
    expect(out.get(26)).toEqual({ ht: 1240, ttc: 1488 });
  });

  it("superseded acompte never counts, even when listed as treat-as-issued", () => {
    const out = computeAcompteCertifiedByDevis([acompteCert({ status: "superseded" })], devisList, [1]);
    expect(out.get(26)).toBeUndefined();
  });

  it("partial recoupment on a later progress certificat reduces the outstanding acompte", () => {
    const out = computeAcompteCertifiedByDevis(
      [acompteCert(), progressCert({ cumulativeAcompteRecoupment: "500.00" })],
      devisList,
    );
    expect(out.get(26)).toEqual({ ht: 740, ttc: 888 });
  });

  it("full recoupment removes the acompte from certified (no double count)", () => {
    const out = computeAcompteCertifiedByDevis(
      [acompteCert(), progressCert({ cumulativeAcompteRecoupment: "1240.00" })],
      devisList,
    );
    expect(out.get(26)).toBeUndefined();
  });

  it("uses the LATEST progress certificat's cumulative, not a sum or max", () => {
    const out = computeAcompteCertifiedByDevis(
      [
        acompteCert(),
        progressCert({ id: 2, dateIssued: "2026-09-01", cumulativeAcompteRecoupment: "900.00" }),
        // A reissue can legitimately lower the cumulative — latest wins.
        progressCert({ id: 3, dateIssued: "2026-09-10", cumulativeAcompteRecoupment: "600.00" }),
      ],
      devisList,
    );
    expect(out.get(26)).toEqual({ ht: 640, ttc: 768 });
  });

  it("superseded progress certificats never feed the recoupment figure", () => {
    const out = computeAcompteCertifiedByDevis(
      [
        acompteCert(),
        progressCert({ id: 2, dateIssued: "2026-09-01", cumulativeAcompteRecoupment: "1240.00", status: "superseded" }),
        progressCert({ id: 3, dateIssued: "2026-09-02", cumulativeAcompteRecoupment: "300.00" }),
      ],
      devisList,
    );
    expect(out.get(26)).toEqual({ ht: 940, ttc: 1128 });
  });

  it("a devis whose deposit was applied through the invoice path contributes 0", () => {
    const out = computeAcompteCertifiedByDevis(
      [acompteCert()],
      [{ id: 26, acompteState: "applied" }],
    );
    expect(out.get(26)).toBeUndefined();
  });

  it("recoupment from another contractor does not touch this acompte", () => {
    const out = computeAcompteCertifiedByDevis(
      [acompteCert(), progressCert({ contractorId: 99, cumulativeAcompteRecoupment: "1240.00" })],
      devisList,
    );
    expect(out.get(26)).toEqual({ ht: 1240, ttc: 1488 });
  });

  it("two acomptes for one contractor: recoupment allocated oldest-first", () => {
    const out = computeAcompteCertifiedByDevis(
      [
        acompteCert({ id: 1, acompteDevisId: 26, totalWorksHt: "1000.00", dateIssued: "2026-08-01" }),
        acompteCert({ id: 4, acompteDevisId: 30, totalWorksHt: "800.00", dateIssued: "2026-08-10" }),
        progressCert({ cumulativeAcompteRecoupment: "1200.00" }),
      ],
      [
        { id: 26, acompteState: "paid" },
        { id: 30, acompteState: "paid" },
      ],
    );
    expect(out.get(26)).toBeUndefined(); // fully recouped
    expect(out.get(30)).toEqual({ ht: 600, ttc: 720 });
  });

  it("a draft progress cert treated as issued applies its own recoupment (own-PDF at seal time)", () => {
    // Sealing a progress certificat: its invoice already counts in the
    // summary and its recoupment was just recomputed — its own whole-project
    // table must reduce the outstanding acompte, or it double-counts.
    const out = computeAcompteCertifiedByDevis(
      [acompteCert(), progressCert({ status: "draft", cumulativeAcompteRecoupment: "1240.00" })],
      devisList,
      [2],
    );
    expect(out.get(26)).toBeUndefined();
  });

  it("TVA autoliquidation-style 0% rate yields TTC equal to HT", () => {
    const out = computeAcompteCertifiedByDevis(
      [acompteCert({ tvaRatePercent: "0.00" })],
      devisList,
    );
    expect(out.get(26)).toEqual({ ht: 1240, ttc: 1240 });
  });
});
