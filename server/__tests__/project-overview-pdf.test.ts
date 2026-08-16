import { describe, it, expect } from "vitest";
import {
  buildProjectOverviewData,
  buildProjectOverviewHtml,
  MAX_DEVIS_ROWS,
} from "../services/project-overview-pdf.service";
import { roundCurrency } from "../../shared/financial-utils";

// Task #413 — the overview addendum must mirror the financial summary
// verbatim: same totals, same active-devis filter, no recomputation.

function devisRow(overrides: Record<string, unknown> = {}) {
  return {
    devisId: 1,
    devisCode: "D-001",
    descriptionFr: "Maçonnerie",
    descriptionUk: "Masonry",
    status: "approved",
    accountingState: "active",
    signOffStage: "client_signed_off",
    contractorId: 10,
    invoicingMode: "standard",
    originalHt: 10000,
    originalTtc: 12000,
    pvTotal: 0,
    mvTotal: 0,
    adjustedHt: 10000,
    adjustedTtc: 12000,
    certifiedHt: 4000,
    certifiedTtc: 4800,
    resteARealiser: 6000,
    resteARealiserTtc: 7200,
    invoiceCount: 2,
    avenantCount: 0,
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 1,
    projectName: "SMITH",
    projectCode: "1304",
    devis: [devisRow()],
    totalContractedHt: 10000,
    totalContractedTtc: 12000,
    totalCertifiedHt: 4000,
    totalCertifiedTtc: 4800,
    totalResteARealiser: 6000,
    totalResteARealiserTtc: 7200,
    totalOriginalHt: 10000,
    totalOriginalTtc: 12000,
    totalPv: 0,
    totalMv: 0,
    ...overrides,
  } as Parameters<typeof buildProjectOverviewData>[0];
}

describe("buildProjectOverviewData", () => {
  it("copies the summary totals verbatim without recomputation", () => {
    const data = buildProjectOverviewData(summary(), "Mme Smith");
    expect(data.totalContractedHt).toBe(10000);
    expect(data.totalContractedTtc).toBe(12000);
    expect(data.totalCertifiedHt).toBe(4000);
    expect(data.totalCertifiedTtc).toBe(4800);
    expect(data.totalResteARealiser).toBe(6000);
    expect(data.totalResteARealiserTtc).toBe(7200);
    expect(data.clientName).toBe("Mme Smith");
  });

  it("computes progress as certified/contracted (HT), rounded to 2dp", () => {
    const data = buildProjectOverviewData(summary(), null);
    expect(data.progressPercent).toBe(40);

    const oddData = buildProjectOverviewData(
      summary({ totalContractedHt: 3000, totalCertifiedHt: 1000 }),
      null,
    );
    expect(oddData.progressPercent).toBe(33.33);
  });

  it("returns 0% when nothing is contracted (no division by zero)", () => {
    const data = buildProjectOverviewData(
      summary({ totalContractedHt: 0, totalCertifiedHt: 0, devis: [] }),
      null,
    );
    expect(data.progressPercent).toBe(0);
    expect(data.devisRows).toHaveLength(0);
  });

  it("caps progress at 100% when over-invoiced", () => {
    const data = buildProjectOverviewData(
      summary({ totalContractedHt: 1000, totalCertifiedHt: 1500 }),
      null,
    );
    expect(data.progressPercent).toBe(100);
  });

  it("only includes active, non-void devis — the same filter as the summary totals", () => {
    const data = buildProjectOverviewData(
      summary({
        devis: [
          devisRow({ devisCode: "D-A" }),
          devisRow({ devisCode: "D-B", accountingState: "provisional" }),
          devisRow({ devisCode: "D-C", accountingState: "superseded" }),
          devisRow({ devisCode: "D-D", status: "void" }),
        ],
      }),
      null,
    );
    expect(data.devisRows.map((r) => r.devisCode)).toEqual(["D-A"]);
  });

  it("flags a devis as signed only when signOffStage is client_signed_off", () => {
    const data = buildProjectOverviewData(
      summary({
        devis: [
          devisRow({ devisCode: "D-A", signOffStage: "client_signed_off" }),
          devisRow({ devisCode: "D-B", signOffStage: "sent" }),
          devisRow({ devisCode: "D-C", signOffStage: null }),
        ],
      }),
      null,
    );
    expect(data.devisRows.map((r) => r.signed)).toEqual([true, false, false]);
  });
  it("keeps all rows itemised at exactly MAX_DEVIS_ROWS (no rollup)", () => {
    const devis = Array.from({ length: MAX_DEVIS_ROWS }, (_, i) =>
      devisRow({ devisCode: `D-${String(i).padStart(3, "0")}` }),
    );
    const data = buildProjectOverviewData(summary({ devis }), null);
    expect(data.devisRows).toHaveLength(MAX_DEVIS_ROWS);
    expect(data.rollup).toBeNull();
  });

  it("folds the tail into a rollup beyond MAX_DEVIS_ROWS, preserving the sums", () => {
    // 30 devis with distinct amounts; largest must stay itemised.
    const devis = Array.from({ length: 30 }, (_, i) =>
      devisRow({
        devisCode: `D-${String(i).padStart(3, "0")}`,
        adjustedHt: 1000 + i * 10.5,
        certifiedHt: 100 + i,
        resteARealiser: 900 + i * 9.5,
      }),
    );
    const data = buildProjectOverviewData(summary({ devis }), null);

    expect(data.devisRows).toHaveLength(MAX_DEVIS_ROWS - 1);
    expect(data.rollup).not.toBeNull();
    expect(data.rollup!.count).toBe(30 - (MAX_DEVIS_ROWS - 1));

    // Largest amounts are the ones kept itemised.
    const keptMin = Math.min(...data.devisRows.map((r) => r.adjustedHt));
    expect(keptMin).toBeGreaterThan(data.rollup!.adjustedHt / data.rollup!.count);

    // Itemised + rollup reproduce the full per-devis sums exactly.
    const sum = (xs: number[]) => roundCurrency(xs.reduce((s, v) => s + v, 0));
    expect(roundCurrency(sum(data.devisRows.map((r) => r.adjustedHt)) + data.rollup!.adjustedHt))
      .toBe(sum(devis.map((d) => d.adjustedHt as number)));
    expect(roundCurrency(sum(data.devisRows.map((r) => r.certifiedHt)) + data.rollup!.certifiedHt))
      .toBe(sum(devis.map((d) => d.certifiedHt as number)));
    expect(roundCurrency(sum(data.devisRows.map((r) => r.resteARealiser)) + data.rollup!.resteARealiser))
      .toBe(sum(devis.map((d) => d.resteARealiser as number)));
  });

  it("renders the rollup row and caps table rows in the HTML", () => {
    const devis = Array.from({ length: 40 }, (_, i) =>
      devisRow({ devisCode: `D-${String(i).padStart(3, "0")}` }),
    );
    const data = buildProjectOverviewData(summary({ devis }), null);
    const html = buildProjectOverviewHtml(data, null);
    expect(html).toContain("autres devis regroupés");
    // Body rows = itemised + rollup, never more than MAX_DEVIS_ROWS.
    const bodyRows = (html.match(/<tr/g) || []).length;
    // header rows + kpi/table scaffolding exist too; just assert devis codes are capped.
    const codeMatches = (html.match(/D-\d{3}/g) || []).length;
    expect(codeMatches).toBe(MAX_DEVIS_ROWS - 1);
    expect(bodyRows).toBeLessThan(30);
  });
});

describe("buildProjectOverviewHtml", () => {
  it("renders French-formatted currency, escaped text, and no CSS grid", () => {
    const data = buildProjectOverviewData(
      summary({ projectName: "SMITH <&> \"CO\"" }),
      "M. & Mme <Smith>",
    );
    const html = buildProjectOverviewHtml(data, null);

    // fr-FR currency: narrow no-break spaces as thousands separators, comma decimals.
    expect(html).toContain("10\u202f000,00 \u20AC");
    expect(html).toContain("Situation financière du projet");
    // Escaping
    expect(html).toContain("SMITH &lt;&amp;&gt;");
    expect(html).toContain("M. &amp; Mme &lt;Smith&gt;");
    expect(html).not.toContain("<Smith>");
    // Prince constraint: no CSS grid anywhere.
    expect(html).not.toMatch(/display\s*:\s*grid/);
    // Progress bar width reflects the percentage.
    expect(html).toContain("width:40%");
  });

  it("shows an empty-state row when there are no active devis", () => {
    const data = buildProjectOverviewData(
      summary({ totalContractedHt: 0, totalCertifiedHt: 0, devis: [] }),
      null,
    );
    const html = buildProjectOverviewHtml(data, null);
    expect(html).toContain("Aucun devis actif");
  });
});
