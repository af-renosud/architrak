import { describe, it, expect } from "vitest";
import {
  partitionDigestRows,
  groupRowsByArchitect,
  buildDigestBody,
  buildPendingInvoicesMap,
} from "../payment-scheduler";
import type { ArchitectFeeInvoice } from "@shared/schema";

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

  it("annotates a milestone line when a matching invoice is pending confirmation", () => {
    const overdue = [
      makeRow({
        id: 7,
        reachedAt: day(10),
        uploadedByUserId: 1,
        projectCode: "VERFEUIL",
        projectName: "TRÜTKEN (VERFEUIL) 1358",
        labelFr: "OUVERTURE ADMINISTRATIVE DE DOSSIER",
        amountTtc: "1800.00",
      }),
    ];
    const pending = new Map([[7, "F-2026-138"]]);
    const { body } = buildDigestBody(overdue, [], pending);
    expect(body).toContain("OUVERTURE ADMINISTRATIVE DE DOSSIER");
    expect(body).toContain("matching invoice F-2026-138 is awaiting your confirmation");
  });

  it("does not annotate a milestone line when no pending invoice is matched", () => {
    const overdue = [
      makeRow({ id: 3, reachedAt: day(8), uploadedByUserId: 1, labelFr: "Permis" }),
    ];
    const { body } = buildDigestBody(overdue, [], new Map());
    expect(body).toContain("Permis");
    expect(body).not.toContain("awaiting your confirmation");
  });
});

// --- helper to make a minimal ArchitectFeeInvoice stub ---
// pending_review invoices have projectId=null (set only on confirmation).
// The candidates JSONB uses the project ID as a string key in "milestones".
function makeAFI(overrides: {
  id: number;
  invoiceNumber: string;
  /** project.id of the due row(s) this invoice should match via candidates */
  candidateProjectId: number;
  milestoneIds: number[];
}): ArchitectFeeInvoice {
  const milestones: Record<string, Array<{ milestoneId: number }>> = {};
  milestones[String(overrides.candidateProjectId)] = overrides.milestoneIds.map((mid) => ({
    milestoneId: mid,
  }));
  return {
    id: overrides.id,
    emailDocumentId: null,
    intakeDocumentId: null,
    // Realistic: projectId is NULL on pending_review rows
    projectId: null,
    milestoneId: null,
    feeEntryId: null,
    invoiceNumber: overrides.invoiceNumber,
    invoiceNumberNormalized: overrides.invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, ""),
    issueDate: null,
    amountHt: null,
    tvaAmount: null,
    amountTtc: null,
    clientName: null,
    devisNumber: null,
    devisNumberNormalized: null,
    fileName: null,
    storageKey: null,
    source: "gmail",
    status: "pending_review",
    identityReason: null,
    candidates: { milestones },
    extractionSnapshot: null,
    reviewedBy: null,
    reviewedAt: null,
    notes: null,
    createdAt: new Date(),
  } as ArchitectFeeInvoice;
}

// makeRow sets project.id = 1; use candidateProjectId: 1 to match those rows.
describe("buildPendingInvoicesMap", () => {
  it("maps milestone id to invoice number when candidates match by project+milestone", () => {
    const rows = [makeRow({ id: 5, reachedAt: day(10), uploadedByUserId: 1 })];
    const afis = [makeAFI({ id: 1, invoiceNumber: "F-2026-138", candidateProjectId: 1, milestoneIds: [5] })];
    const map = buildPendingInvoicesMap(rows, afis);
    expect(map.get(5)).toBe("F-2026-138");
  });

  it("returns an empty map when candidates mention a different project's milestone id", () => {
    // milestone id 5 exists in project 99's candidates, but due row is project 1
    const rows = [makeRow({ id: 5, reachedAt: day(10), uploadedByUserId: 1 })];
    const afis = [makeAFI({ id: 1, invoiceNumber: "F-2026-999", candidateProjectId: 99, milestoneIds: [5] })];
    const map = buildPendingInvoicesMap(rows, afis);
    expect(map.size).toBe(0);
  });

  it("returns an empty map when no AFI candidates match any due milestone id", () => {
    const rows = [makeRow({ id: 5, reachedAt: day(10), uploadedByUserId: 1 })];
    const afis = [makeAFI({ id: 1, invoiceNumber: "F-2026-999", candidateProjectId: 1, milestoneIds: [99] })];
    const map = buildPendingInvoicesMap(rows, afis);
    expect(map.size).toBe(0);
  });

  it("skips AFIs with no invoice number", () => {
    const rows = [makeRow({ id: 5, reachedAt: day(10), uploadedByUserId: 1 })];
    const base = makeAFI({ id: 1, invoiceNumber: "F-X", candidateProjectId: 1, milestoneIds: [5] });
    const map = buildPendingInvoicesMap(rows, [{ ...base, invoiceNumber: null } as unknown as ArchitectFeeInvoice]);
    expect(map.size).toBe(0);
  });

  it("only stores the first matching invoice per milestone when multiple AFIs match", () => {
    const rows = [makeRow({ id: 5, reachedAt: day(10), uploadedByUserId: 1 })];
    const afis = [
      makeAFI({ id: 1, invoiceNumber: "F-2026-001", candidateProjectId: 1, milestoneIds: [5] }),
      makeAFI({ id: 2, invoiceNumber: "F-2026-002", candidateProjectId: 1, milestoneIds: [5] }),
    ];
    const map = buildPendingInvoicesMap(rows, afis);
    expect(map.get(5)).toBe("F-2026-001");
    expect(map.size).toBe(1);
  });
});
