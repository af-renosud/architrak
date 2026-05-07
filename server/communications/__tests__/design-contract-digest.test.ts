import { describe, it, expect } from "vitest";
import {
  partitionDigestRows,
  groupRowsByArchitect,
  buildDigestBody,
} from "../payment-scheduler";

type Row = ReturnType<typeof groupRowsByArchitect> extends Map<number, infer V>
  ? V[number]
  : never;

function makeRow(overrides: {
  id: number;
  reachedAt: Date | null;
  uploadedByUserId: number | null;
  projectCode?: string;
  projectName?: string;
  labelFr?: string;
  amountTtc?: string;
}): Row {
  return {
    milestone: {
      id: overrides.id,
      contractId: 1,
      sequence: 1,
      labelFr: overrides.labelFr ?? "Acompte",
      labelEn: null,
      percentage: "30.00",
      amountTtc: overrides.amountTtc ?? "1000.00",
      triggerEvent: "manual",
      status: "reached",
      notes: null,
      reachedAt: overrides.reachedAt,
      reachedByUserId: null,
      reminderLastSentAt: null,
      createdAt: new Date(),
    },
    contract: {
      id: 1,
      projectId: 1,
      storageKey: "k",
      originalFilename: "c.pdf",
      totalHt: null,
      totalTva: null,
      totalTtc: "1000.00",
      tvaRate: null,
      conceptionAmountHt: null,
      planningAmountHt: null,
      contractDate: null,
      contractReference: null,
      clientName: null,
      architectName: null,
      projectAddress: null,
      extractionConfidence: null,
      extractionWarnings: null,
      uploadedByUserId: overrides.uploadedByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    project: {
      id: 1,
      code: overrides.projectCode ?? "P-001",
      name: overrides.projectName ?? "Project",
      // Cast — only fields read by the digest are exercised here.
    } as Row["project"],
  } as Row;
}

const NOW = new Date("2026-05-07T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("design-contract digest — partitioning", () => {
  it("classifies >7d as overdue and ≤7d as imminent", () => {
    const rows = [
      makeRow({ id: 1, reachedAt: day(10), uploadedByUserId: 1 }),
      makeRow({ id: 2, reachedAt: day(3), uploadedByUserId: 1 }),
      makeRow({ id: 3, reachedAt: day(0), uploadedByUserId: 1 }),
    ];
    const { overdue, imminent } = partitionDigestRows(rows, NOW);
    expect(overdue.map((r) => r.milestone.id)).toEqual([1]);
    expect(imminent.map((r) => r.milestone.id)).toEqual([2, 3]);
  });

  it("excludes milestones older than the 14d imminent window from imminent (still in overdue)", () => {
    const rows = [makeRow({ id: 1, reachedAt: day(20), uploadedByUserId: 1 })];
    const { overdue, imminent } = partitionDigestRows(rows, NOW);
    expect(overdue).toHaveLength(1);
    expect(imminent).toHaveLength(0);
  });

  it("skips rows with null reachedAt", () => {
    const rows = [makeRow({ id: 1, reachedAt: null, uploadedByUserId: 1 })];
    const { overdue, imminent } = partitionDigestRows(rows, NOW);
    expect(overdue).toHaveLength(0);
    expect(imminent).toHaveLength(0);
  });
});

describe("design-contract digest — per-architect grouping", () => {
  it("groups by uploadedByUserId and drops rows without an uploader", () => {
    const rows = [
      makeRow({ id: 1, reachedAt: day(10), uploadedByUserId: 1 }),
      makeRow({ id: 2, reachedAt: day(3), uploadedByUserId: 2 }),
      makeRow({ id: 3, reachedAt: day(1), uploadedByUserId: 1 }),
      makeRow({ id: 4, reachedAt: day(1), uploadedByUserId: null }),
    ];
    const grouped = groupRowsByArchitect(rows);
    expect(grouped.size).toBe(2);
    expect(grouped.get(1)?.map((r) => r.milestone.id)).toEqual([1, 3]);
    expect(grouped.get(2)?.map((r) => r.milestone.id)).toEqual([2]);
  });
});

describe("design-contract digest — email body composition", () => {
  it("includes both OVERDUE and UPCOMING sections when both are present", () => {
    const overdue = [
      makeRow({
        id: 1,
        reachedAt: day(10),
        uploadedByUserId: 1,
        projectCode: "ALPHA",
        projectName: "Alpha",
        labelFr: "Permis",
        amountTtc: "5000.00",
      }),
    ];
    const imminent = [
      makeRow({
        id: 2,
        reachedAt: day(2),
        uploadedByUserId: 1,
        projectCode: "BETA",
        projectName: "Beta",
        labelFr: "Acompte",
        amountTtc: "2500.00",
      }),
    ];
    const { subject, body } = buildDigestBody(overdue, imminent);
    expect(subject).toBe("[Architrak] 2 design-contract milestone(s) awaiting invoice");
    expect(body).toContain("OVERDUE — reached more than 7 days ago (1)");
    expect(body).toContain("UPCOMING — reached within last 14 days (1)");
    expect(body).toContain("[ALPHA] Alpha");
    expect(body).toContain("[BETA] Beta");
    expect(body).toContain("/dashboard");
  });

  it("omits the OVERDUE section when none are overdue", () => {
    const { body } = buildDigestBody(
      [],
      [makeRow({ id: 1, reachedAt: day(2), uploadedByUserId: 1 })],
    );
    expect(body).not.toContain("OVERDUE");
    expect(body).toContain("UPCOMING");
  });
});
