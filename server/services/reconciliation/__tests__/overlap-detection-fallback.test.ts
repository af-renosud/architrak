import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Devis } from "@shared/schema";

vi.mock("../../../db", () => ({ db: { transaction: vi.fn() } }));
vi.mock("../../../storage", () => ({
  storage: {
    getDevisByProject: vi.fn(),
    getDevisLineItems: vi.fn(),
    findSimilarProjectDevis: vi.fn(),
  },
}));
vi.mock("../embeddings", () => ({
  isAiAvailable: vi.fn(() => true),
  ensureScopeEmbeddings: vi.fn(async () => {}),
}));
vi.mock("../reasoning", () => ({ classifyRelationship: vi.fn() }));

import { runProjectReconciliation } from "../overlap-detection.service";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { classifyRelationship } from "../reasoning";

const mockedDb = db as unknown as { transaction: ReturnType<typeof vi.fn> };
const mockedStorage = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedClassify = classifyRelationship as unknown as ReturnType<typeof vi.fn>;

function devis(id: number, amountHt: string): Devis {
  return {
    id,
    devisCode: `DEV-${id}`,
    descriptionFr: `Travaux ${id}`,
    contractorId: 1,
    amountHt,
    status: "draft",
  } as unknown as Devis;
}

// Capture rows handed to tx.insert(...).values(...).
function setupTx(): { inserted: Array<Record<string, unknown>> } {
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflictDoUpdate: async () => {} };
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  mockedDb.transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<void>) => {
    await fn(tx);
  });
  return { inserted };
}

describe("runProjectReconciliation — AI degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 100 + 200 = 300 → an arithmetically-reconciling aggregation.
    mockedStorage.getDevisByProject.mockResolvedValue([
      devis(1, "100.00"),
      devis(2, "200.00"),
      devis(3, "300.00"),
    ]);
    mockedStorage.getDevisLineItems.mockResolvedValue([]);
    mockedStorage.findSimilarProjectDevis.mockResolvedValue([]);
  });

  it("falls back to a deterministic 'aggregates' case when AI errors (returns null)", async () => {
    const { inserted } = setupTx();
    mockedClassify.mockResolvedValue(null); // transient model/parse failure

    const summary = await runProjectReconciliation(42);

    expect(mockedClassify).toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      relationshipType: "aggregates",
      verdict: "proven",
      detectionSource: "arithmetic",
      primaryDevisId: 3,
      memberDevisIds: [1, 2],
    });
    expect(summary.detected).toBe(1);
    expect(summary.proven).toBe(1);
  });

  it("still drops a candidate the model explicitly judges 'unrelated'", async () => {
    const { inserted } = setupTx();
    mockedClassify.mockResolvedValue({
      relationshipType: "unrelated",
      confidence: 0.9,
      reasoning: "coincidence",
      citations: [],
    });

    const summary = await runProjectReconciliation(42);

    expect(inserted).toHaveLength(0);
    expect(summary.detected).toBe(0);
  });
});
