import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #450 — Situation traffic-light review service.
//
// Covers:
//  1. mapClaimedPercents: description matching, containment, positional
//     fallback, unmatched → null.
//  2. createDraftSituationFromParsed: server-computed money (roundCurrency),
//     baseline chaining from the latest CONFIRMED situation, draft guard,
//     mode_b guard, no-percentages guard.
//  3. confirmSituation: refuses unresolved lines, recomputes before flip,
//     refuses non-draft.
//  4. getSituationReview flags: regression / jump / claim_on_rejected.

const { storageSpy } = vi.hoisted(() => ({
  storageSpy: {
    getDevis: vi.fn(),
    getDevisLineItems: vi.fn(),
    getSituationsByDevis: vi.fn(),
    getSituation: vi.fn(),
    getSituationLines: vi.fn(),
    createSituation: vi.fn(),
    createSituationLine: vi.fn(),
    updateSituation: vi.fn(),
    updateSituationLine: vi.fn(),
    attachSituationSourcePdf: vi.fn(async () => ({})),
    getSituationLine: vi.fn(),
  },
}));
vi.mock("../../storage", () => ({ storage: storageSpy }));

import {
  mapClaimedPercents,
  createDraftSituationFromParsed,
  confirmSituation,
  getSituationReview,
  SituationReviewError,
} from "../situation-review.service";
import type { DevisLineItem } from "@shared/schema";

function dl(id: number, lineNumber: number, description: string, totalHt: string, checkStatus = "green"): DevisLineItem {
  return { id, lineNumber, description, totalHt, checkStatus } as unknown as DevisLineItem;
}

const devisModeB = {
  id: 7,
  invoicingMode: "mode_b",
  amountHt: "1000.00",
  amountTtc: "1200.00",
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mapClaimedPercents", () => {
  const lines = [dl(1, 1, "Démolition cloison"), dl(2, 2, "Plomberie salle de bain"), dl(3, 3, "Peinture murs")];

  it("matches by normalized description (accents/case-insensitive)", () => {
    const m = mapClaimedPercents(lines as DevisLineItem[], [
      { description: "PLOMBERIE salle de bain", percentComplete: 40 },
      { description: "demolition cloison", percentComplete: 100 },
    ]);
    expect(m.get(1)).toBe(100);
    expect(m.get(2)).toBe(40);
    expect(m.get(3)).toBeNull();
  });

  it("falls back to positional mapping only when counts match and nothing matched by text", () => {
    const m = mapClaimedPercents(lines as DevisLineItem[], [
      { description: "poste 1", percentComplete: 10 },
      { description: "poste 2", percentComplete: 20 },
      { description: "poste 3", percentComplete: 30 },
    ]);
    expect(m.get(1)).toBe(10);
    expect(m.get(2)).toBe(20);
    expect(m.get(3)).toBe(30);
  });

  it("does NOT position-map when counts differ", () => {
    const m = mapClaimedPercents(lines as DevisLineItem[], [
      { description: "poste 1", percentComplete: 10 },
    ]);
    expect(m.get(1)).toBeNull();
    expect(m.get(2)).toBeNull();
  });

  it("clamps claimed percent into 0..100", () => {
    const m = mapClaimedPercents([lines[0]] as DevisLineItem[], [
      { description: "Démolition cloison", percentComplete: 250 },
    ]);
    expect(m.get(1)).toBe(100);
  });
});

describe("createDraftSituationFromParsed", () => {
  const parsed = {
    documentType: "situation",
    date: "2026-08-01",
    lineItems: [
      { description: "Démolition cloison", percentComplete: 50 },
      { description: "Plomberie salle de bain", percentComplete: 30 },
    ],
  } as never;

  it("rejects non-mode_b devis", async () => {
    await expect(
      createDraftSituationFromParsed({ devis: { ...(devisModeB as object), invoicingMode: "mode_a" } as never, parsed, fileName: "s.pdf", storageKey: "k" }),
    ).rejects.toThrow(SituationReviewError);
  });

  it("rejects when no per-line percentages were extracted", async () => {
    storageSpy.getDevisLineItems.mockResolvedValue([dl(1, 1, "Démolition cloison", "333.33")]);
    await expect(
      createDraftSituationFromParsed({
        devis: devisModeB,
        parsed: { documentType: "situation", lineItems: [{ description: "x" }] } as never,
        fileName: "s.pdf",
        storageKey: "k",
      }),
    ).rejects.toThrow(/no per-line completion/i);
  });

  it("rejects when a draft situation already exists", async () => {
    storageSpy.getDevisLineItems.mockResolvedValue([dl(1, 1, "Démolition cloison", "333.33")]);
    storageSpy.getSituationsByDevis.mockResolvedValue([{ id: 1, situationNumber: 1, status: "draft" }]);
    await expect(
      createDraftSituationFromParsed({ devis: devisModeB, parsed, fileName: "s.pdf", storageKey: "k" }),
    ).rejects.toThrow(/draft situation already exists/i);
  });

  it("computes rounded money, chains the baseline, and persists provenance", async () => {
    const devisLines = [
      dl(1, 1, "Démolition cloison", "333.33"),
      dl(2, 2, "Plomberie salle de bain", "666.67"),
    ];
    storageSpy.getDevisLineItems.mockResolvedValue(devisLines);
    // One prior CONFIRMED situation (nº1) as the baseline.
    storageSpy.getSituationsByDevis.mockResolvedValue([
      { id: 41, situationNumber: 1, status: "confirmed" },
    ]);
    storageSpy.getSituationLines.mockResolvedValue([
      { devisLineItemId: 1, percentComplete: "20.00", cumulativeAmount: "66.67" },
    ]);
    storageSpy.createSituation.mockImplementation(async (row: Record<string, unknown>) => ({ id: 42, ...row }));
    storageSpy.createSituationLine.mockImplementation(async (row: Record<string, unknown>) => ({ id: Math.random(), ...row }));

    const { situation } = await createDraftSituationFromParsed({
      devis: devisModeB,
      parsed,
      fileName: "situation-2.pdf",
      storageKey: "intake/situation-2.pdf",
    });

    const created = storageSpy.createSituation.mock.calls[0][0];
    expect(created.situationNumber).toBe(2);
    expect(created.status).toBe("draft");
    expect(storageSpy.attachSituationSourcePdf).toHaveBeenCalledWith(42, expect.objectContaining({
      sourceStorageKey: "intake/situation-2.pdf",
      sourceFileName: "situation-2.pdf",
      sourceUploadedBy: "intake-auto",
      confirmed: false,
    }));

    // Line 1: 333.33 * 50% = 166.67 (rounded), previous 66.67 → net 100.00
    // Line 2: 666.67 * 30% = 200.00, previous 0 → net 200.00
    const lineRows = storageSpy.createSituationLine.mock.calls.map((c) => c[0]);
    expect(lineRows[0]).toMatchObject({
      devisLineItemId: 1,
      percentComplete: "50.00",
      claimedPercent: "50.00",
      cumulativeAmount: "166.67",
      previousAmount: "66.67",
      netAmount: "100.00",
      checkStatus: "unchecked",
    });
    expect(lineRows[1]).toMatchObject({
      devisLineItemId: 2,
      cumulativeAmount: "200.00",
      previousAmount: "0.00",
      netAmount: "200.00",
    });

    // Header: cumulative 366.67, previous 66.67, net 300.00, TVA 20% → 60.00
    expect(created.cumulativeHt).toBe("366.67");
    expect(created.previousHt).toBe("66.67");
    expect(created.netHt).toBe("300.00");
    expect(created.netToPayHt).toBe("300.00");
    expect(created.tvaAmount).toBe("60.00");
    expect(created.netToPayTtc).toBe("360.00");
    expect(situation.id).toBe(42);
  });

  it("carries the previous % forward for unclaimed lines", async () => {
    storageSpy.getDevisLineItems.mockResolvedValue([
      dl(1, 1, "Démolition cloison", "100.00"),
      dl(2, 2, "Ligne sans claim", "100.00"),
    ]);
    storageSpy.getSituationsByDevis.mockResolvedValue([{ id: 41, situationNumber: 1, status: "confirmed" }]);
    storageSpy.getSituationLines.mockResolvedValue([
      { devisLineItemId: 2, percentComplete: "40.00", cumulativeAmount: "40.00" },
    ]);
    storageSpy.createSituation.mockImplementation(async (row: Record<string, unknown>) => ({ id: 43, ...row }));
    storageSpy.createSituationLine.mockImplementation(async (row: Record<string, unknown>) => ({ id: 1, ...row }));

    await createDraftSituationFromParsed({
      devis: devisModeB,
      parsed: {
        documentType: "situation",
        lineItems: [{ description: "Démolition cloison", percentComplete: 80 }],
      } as never,
      fileName: "s.pdf",
      storageKey: "k",
    });
    const rows = storageSpy.createSituationLine.mock.calls.map((c) => c[0]);
    const unclaimed = rows.find((r) => r.devisLineItemId === 2);
    expect(unclaimed).toMatchObject({
      claimedPercent: null,
      percentComplete: "40.00", // carried forward
      netAmount: "0.00", // no movement this period
    });
  });
});

describe("confirmSituation", () => {
  it("refuses when any line is unresolved", async () => {
    storageSpy.getSituation.mockResolvedValue({ id: 5, devisId: 7, status: "draft" });
    storageSpy.getSituationLines.mockResolvedValue([
      { id: 1, checkStatus: "green" },
      { id: 2, checkStatus: "unchecked" },
    ]);
    await expect(confirmSituation(5)).rejects.toThrow(/unresolved/i);
    expect(storageSpy.updateSituation).not.toHaveBeenCalled();
  });

  it("refuses non-draft situations", async () => {
    storageSpy.getSituation.mockResolvedValue({ id: 5, devisId: 7, status: "confirmed" });
    await expect(confirmSituation(5)).rejects.toThrow(/draft/i);
  });

  it("recomputes and flips draft → confirmed when all lines resolved", async () => {
    const situation = { id: 5, devisId: 7, status: "draft" };
    storageSpy.getSituation.mockResolvedValue(situation);
    storageSpy.getSituationLines.mockResolvedValue([
      { id: 1, devisLineItemId: 1, checkStatus: "green", percentComplete: "50.00", previousAmount: "0.00" },
    ]);
    storageSpy.getDevis.mockResolvedValue(devisModeB);
    storageSpy.getDevisLineItems.mockResolvedValue([dl(1, 1, "Démolition", "100.00")]);
    storageSpy.updateSituationLine.mockResolvedValue({});
    storageSpy.updateSituation.mockImplementation(async (_id: number, patch: Record<string, unknown>) => ({ ...situation, ...patch }));

    const confirmed = await confirmSituation(5);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
    // Recompute persisted server-side money for the line first.
    expect(storageSpy.updateSituationLine).toHaveBeenCalledWith(1, {
      cumulativeAmount: "50.00",
      netAmount: "50.00",
    });
  });
});

describe("getSituationReview flags", () => {
  it("flags regression, jump and claim_on_rejected", async () => {
    storageSpy.getSituation.mockResolvedValue({ id: 9, devisId: 7, status: "draft" });
    storageSpy.getDevis.mockResolvedValue(devisModeB);
    storageSpy.getDevisLineItems.mockResolvedValue([
      dl(1, 1, "Régression", "100.00", "green"),
      dl(2, 2, "Saut", "100.00", "green"),
      dl(3, 3, "Rejetée", "100.00", "red"),
    ]);
    storageSpy.getSituationLines.mockResolvedValue([
      // previous 50% (previousAmount 50 of 100), claimed 30 → regression
      { id: 11, devisLineItemId: 1, percentComplete: "30.00", claimedPercent: "30.00", previousAmount: "50.00", cumulativeAmount: "30.00", netAmount: "-20.00", checkStatus: "unchecked", checkNotes: null },
      // previous 10%, claimed 90 → jump (>50 points)
      { id: 12, devisLineItemId: 2, percentComplete: "90.00", claimedPercent: "90.00", previousAmount: "10.00", cumulativeAmount: "90.00", netAmount: "80.00", checkStatus: "unchecked", checkNotes: null },
      // devis line was red, claimed increase → claim_on_rejected
      { id: 13, devisLineItemId: 3, percentComplete: "20.00", claimedPercent: "20.00", previousAmount: "0.00", cumulativeAmount: "20.00", netAmount: "20.00", checkStatus: "unchecked", checkNotes: null },
    ]);

    const { lines } = await getSituationReview(9);
    expect(lines.find((l) => l.id === 11)!.flags).toContain("regression");
    expect(lines.find((l) => l.id === 12)!.flags).toContain("jump");
    expect(lines.find((l) => l.id === 13)!.flags).toContain("claim_on_rejected");
    expect(lines.find((l) => l.id === 11)!.previousPercent).toBe(50);
  });
});
