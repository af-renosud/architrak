import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { storage } from "../storage";

afterEach(() => vi.restoreAllMocks());

function transactionFixture(doc: Record<string, unknown>, provenance: unknown[] = []) {
  const remove = vi.fn().mockResolvedValue(undefined);
  const tombstone = vi.fn().mockResolvedValue(undefined);
  const results = [[doc], provenance, [], []];
  const tx = {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({
        for: async () => results.shift(),
        limit: async () => results.shift(),
      }) }),
    })),
    delete: vi.fn(() => ({ where: remove })),
    update: vi.fn(() => ({ set: () => ({ where: tombstone }) })),
  };
  vi.spyOn(db, "transaction").mockImplementation(async (fn: any) => fn(tx));
  return { tx, remove, tombstone };
}

describe("intake deletion rechecks under lock", () => {
  it.each([
    { analysisState: "analyzing" },
    { analysisState: "pending" },
    { analysisState: "analyzed", promotedId: 42 },
  ])("refuses newly busy/promoted documents without tombstoning email", async (state) => {
    const fixture = transactionFixture({ id: 1, sourceEmailDocumentId: 2, ...state });
    await expect(storage.deleteProjectIntakeDocument(1)).rejects.toThrow("cannot be deleted");
    expect(fixture.tx.delete).not.toHaveBeenCalled();
    expect(fixture.tx.update).not.toHaveBeenCalled();
  });
  it("refuses retained provenance even without promotedId", async () => {
    const fixture = transactionFixture({ id: 1, analysisState: "analyzed" }, [{ id: 9 }]);
    await expect(storage.deleteProjectIntakeDocument(1)).rejects.toThrow("retained evidence");
    expect(fixture.tx.delete).not.toHaveBeenCalled();
  });
  it("tombstones the email only after a successful deletion", async () => {
    const fixture = transactionFixture({ id: 1, analysisState: "analyzed", sourceEmailDocumentId: 2 });
    await storage.deleteProjectIntakeDocument(1);
    expect(fixture.remove).toHaveBeenCalledTimes(1);
    expect(fixture.tombstone).toHaveBeenCalledTimes(1);
    expect(fixture.remove.mock.invocationCallOrder[0]).toBeLessThan(fixture.tombstone.mock.invocationCallOrder[0]);
  });
  it("does not tombstone when a restrictive evidence FK refuses deletion", async () => {
    const fixture = transactionFixture({ id: 1, analysisState: "analyzed", sourceEmailDocumentId: 2 });
    fixture.remove.mockRejectedValue(new Error("retained evidence"));
    await expect(storage.deleteProjectIntakeDocument(1)).rejects.toThrow("retained evidence");
    expect(fixture.tx.update).not.toHaveBeenCalled();
  });
});
