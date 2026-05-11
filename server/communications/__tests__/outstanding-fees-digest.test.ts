import { describe, it, expect } from "vitest";
import {
  buildOutstandingFeesDigest,
  localDateKey,
  parseDigestRecipients,
  shouldSendDigest,
} from "../outstanding-fees-digest";
import type {
  OutstandingFeeEntry,
  OutstandingFeeSummary,
} from "@shared/fee-description";
import { summarizeOutstandingFees } from "@shared/fee-description";

function makeEntry(overrides: Partial<OutstandingFeeEntry> = {}): OutstandingFeeEntry {
  return {
    entryId: 1,
    feeId: 1,
    projectId: 1,
    projectName: "Maison Dupont",
    projectCode: "MD-001",
    contractorName: "Plomberie SARL",
    invoiceId: 10,
    invoiceNumber: "INV-2026-0042",
    devisId: 5,
    devisCode: "DEV-007",
    amountHt: 10000,
    amountTtc: 12000,
    feePercentage: 12,
    feeAmountHt: 1200,
    createdAt: "2026-04-01T00:00:00.000Z",
    ageDays: 40,
    ...overrides,
  };
}

describe("outstanding-fees-digest — recipient parsing", () => {
  it("returns [] when env var is unset/empty", () => {
    expect(parseDigestRecipients(undefined)).toEqual([]);
    expect(parseDigestRecipients("")).toEqual([]);
    expect(parseDigestRecipients("  ,  ,")).toEqual([]);
  });
  it("splits CSV and trims whitespace", () => {
    expect(parseDigestRecipients("a@x.com, b@y.com  , c@z.com")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });
});

describe("outstanding-fees-digest — shouldSendDigest", () => {
  // 2026-05-11 is a Monday.
  const monday8 = new Date("2026-05-11T08:00:00");
  const monday7 = new Date("2026-05-11T07:00:00");
  const tuesday9 = new Date("2026-05-12T09:00:00");

  it("fires Monday at/after the configured hour", () => {
    expect(shouldSendDigest(monday8, null, 8)).toBe(true);
  });
  it("does not fire Monday before the configured hour", () => {
    expect(shouldSendDigest(monday7, null, 8)).toBe(false);
  });
  it("does not fire on a non-Monday", () => {
    expect(shouldSendDigest(tuesday9, null, 8)).toBe(false);
  });
  it("does not double-fire if already sent today (using local date key)", () => {
    expect(shouldSendDigest(monday8, localDateKey(monday8), 8)).toBe(false);
  });
  it("uses a local-time date key so a UTC-midnight crossing on the same local Monday still dedupes", () => {
    // Same local Monday, hours apart. The dedupe key must not flip even
    // if UTC midnight rolls between the two ticks (server in a positive
    // UTC offset). Both keys must be equal.
    const earlyMon = new Date(2026, 4, 11, 8, 0, 0); // local 08:00
    const lateMon = new Date(2026, 4, 11, 23, 30, 0); // local 23:30
    expect(localDateKey(earlyMon)).toBe(localDateKey(lateMon));
    expect(shouldSendDigest(lateMon, localDateKey(earlyMon), 8)).toBe(false);
  });
});

describe("outstanding-fees-digest — localDateKey", () => {
  it("formats local date components as YYYY-MM-DD with zero-padding", () => {
    expect(localDateKey(new Date(2026, 0, 5, 0, 0, 0))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31");
  });
});

describe("outstanding-fees-digest — body composition", () => {
  const now = new Date("2026-05-11T08:00:00Z");

  it("renders an empty-state digest gracefully", () => {
    const summary: OutstandingFeeSummary = summarizeOutstandingFees([]);
    const { subject, body } = buildOutstandingFeesDigest(summary, now);
    expect(subject).toContain("0 entries");
    expect(body).toContain("Total: 0 entries");
    expect(body).toContain("Aging buckets:");
    expect(body).not.toContain("Per-entry detail:");
  });

  it("includes per-entry copy paragraphs from buildFeeInvoiceDescription", () => {
    const entries = [
      makeEntry({ entryId: 1, ageDays: 10 }),
      makeEntry({
        entryId: 2,
        projectCode: "BG-002",
        projectName: "Bureau Gauthier",
        contractorName: "Électricité Plus",
        invoiceNumber: "FAC-99",
        devisCode: "DEV-018",
        amountHt: 5000,
        amountTtc: 6000,
        feePercentage: 10,
        feeAmountHt: 500,
        ageDays: 75,
      }),
    ];
    const summary = summarizeOutstandingFees(entries);
    const { subject, body } = buildOutstandingFeesDigest(summary, now);

    expect(subject).toContain("2 entries");
    expect(subject).toContain("2026-05-11");

    // Aging buckets are present.
    expect(body).toContain("0-30 days: 1 entry(ies)");
    expect(body).toContain("61-90 days: 1 entry(ies)");

    // Project rollup line.
    expect(body).toContain("[MD-001] Maison Dupont");
    expect(body).toContain("[BG-002] Bureau Gauthier");

    // Per-entry paragraphs use the canonical builder verbatim.
    expect(body).toContain(
      "Architects' Project Management Fees against contractor: Plomberie SARL",
    );
    expect(body).toContain("Invoice: INV-2026-0042");
    expect(body).toContain("Corresponding signed Devis: DEV-007");
    expect(body).toContain(
      "Architects' Project Management Fees against contractor: Électricité Plus",
    );
    expect(body).toContain("Invoice: FAC-99");
    expect(body).toContain("age 75d");
  });
});
