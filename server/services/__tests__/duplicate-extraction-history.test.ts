import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("../../db", () => ({ pool: { query } }));
import { getDuplicateCorrectionHistory } from "../duplicate-extraction";

beforeEach(() => { query.mockReset(); });
describe("quotation correction history projection", () => {
  it("distinguishes a missing quotation from an empty history", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(getDuplicateCorrectionHistory(999)).rejects.toMatchObject({ status: 404 });
    expect(query).toHaveBeenCalledTimes(1);
    query.mockResolvedValueOnce({ rows: [{ id: 42 }] }).mockResolvedValueOnce({ rows: [] });
    await expect(getDuplicateCorrectionHistory(42)).resolves.toEqual([]);
  });
  it("returns historical evidence only, scoped and newest first without modifying the audit", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 42 }] }).mockResolvedValueOnce({ rows: [{
      id: 8, created_at: new Date("2026-10-04T12:00:00Z"), actor_id: 3, actor_name: "Alex Reviewer",
      reason: "Repeated heading on page 2", removed_line_id: 10, retained_line_id: 11,
      removed_number: "2", removed_description: "Heading", removed_total: "100.00",
      retained_number: "3", retained_description: "Detailed item", retained_total: "100.00",
      source_total: "100.00", before_sum: "200.00", after_sum: "100.00",
      before_discrepancy: "100.00", after_discrepancy: "0.00",
      snapshot: { pdf_storage_key: "private", fingerprint: "secret" }, private_link: "private",
    }] });
    const result = await getDuplicateCorrectionHistory(42);
    expect(result).toEqual([{
      id: 8, createdAt: "2026-10-04T12:00:00.000Z", actor: { id: 3, name: "Alex Reviewer" },
      reason: "Repeated heading on page 2",
      removedLine: { id: 10, lineNumber: 2, description: "Heading", totalHt: "100.00" },
      retainedLine: { id: 11, lineNumber: 3, description: "Detailed item", totalHt: "100.00" },
      reconciliation: { sourceTotalHt: "100.00", beforeSumHt: "200.00", afterSumHt: "100.00",
        discrepancyBeforeHt: "100.00", discrepancyAfterHt: "0.00" },
    }]);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain("WHERE a.devis_id=$1 ORDER BY a.created_at DESC, a.id DESC");
    expect(params).toEqual([42]);
    expect(sql).not.toMatch(/SELECT\s+\*|JOIN devis_line_items|\b(?:UPDATE|INSERT|DELETE)\b/i);
    expect(JSON.stringify(result)).not.toMatch(/snapshot|fingerprint|private/);
  });
  it("keeps a stable actor reference when the account no longer exists", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 42 }] }).mockResolvedValueOnce({
      rows: [{ id: 1, actor_id: 9, actor_name: null, created_at: new Date() }],
    });
    expect((await getDuplicateCorrectionHistory(42))[0].actor).toEqual({ id: 9, name: "User #9" });
  });
});